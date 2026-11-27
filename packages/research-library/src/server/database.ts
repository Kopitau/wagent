import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure non-Effect storage package accesses node:fs directly for SQLite directory setup.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure non-Effect storage package accesses node:path directly for SQLite paths.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { composeLibraryDraft } from "../draft.ts";
import {
  LibraryDuplicateUrlError,
  LibraryEditConflictError,
  LibraryNotFoundError,
  LibraryValidationError,
} from "../errors.ts";
import {
  LIBRARY_DEFAULT_LIST_LIMIT,
  LIBRARY_MAX_DRAFT_ITEMS,
  LIBRARY_MAX_LIST_LIMIT,
  LIBRARY_PAGE_EXTRACTION_STATUSES,
  LIBRARY_SNIPPET_MAX_CHARS,
  type ComposeLibraryDraftResult,
  type DeleteLibraryEntryInput,
  type DeleteLibraryEntryResult,
  type ImportTextFileInput,
  type LibraryEntry,
  type LibraryEntryKind,
  type LibraryEntryPage,
  type LibraryEntrySummary,
  type LibraryPageExtractionStatus,
  type LibrarySearchMode,
  type ListLibraryEntriesInput,
  type ListLibraryEntriesResult,
  type SaveLibraryEntryInput,
  type UpdateLibraryEntryInput,
} from "../types.ts";
import {
  normalizeLibraryBody,
  normalizeLibraryNote,
  normalizeLibraryQuery,
  normalizeLibraryTags,
  normalizeLibraryTitle,
  normalizeLibraryUrl,
  validateLibraryKind,
  validateTextImportFile,
} from "../validation.ts";

const SCHEMA_VERSION = 1;
const MAX_QUERY_TERMS = 8;
const MAX_MATCHED_PAGES_PER_SUMMARY = 8;
const VALID_PAGE_STATUSES: ReadonlySet<string> = new Set(LIBRARY_PAGE_EXTRACTION_STATUSES);

interface EntryRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly url: string | null;
  readonly body: string;
  readonly note: string;
  readonly tags_json: string;
  readonly blob_sha256: string | null;
  readonly blob_bytes: number | null;
  readonly page_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: number;
}

interface SummaryRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly url: string | null;
  readonly tags_json: string;
  readonly body_snippet: string;
  readonly note_snippet: string;
  readonly page_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly revision: number;
}

interface PageRow {
  readonly physical_page: number;
  readonly text: string;
  readonly extraction_status: string;
}

export interface OpenLibraryDatabaseOptions {
  readonly dbPath: string;
  readonly forceDisableFts?: boolean | undefined;
  readonly isWindows?: boolean | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface LibraryDatabase {
  readonly dbPath: string;
  readonly ftsEnabled: boolean;
  readonly close: () => void;
  readonly rebuildSearchIndex: () => void;
  readonly saveEntry: (input: SaveLibraryEntryInput) => LibraryEntry;
  readonly importTextFile: (input: ImportTextFileInput) => LibraryEntry;
  readonly getEntry: (id: string) => LibraryEntry | null;
  readonly getEntryPages: (entryId: string) => ReadonlyArray<LibraryEntryPage>;
  readonly listEntries: (input?: ListLibraryEntriesInput) => ListLibraryEntriesResult;
  readonly updateEntry: (input: UpdateLibraryEntryInput) => LibraryEntry;
  readonly deleteEntry: (input: DeleteLibraryEntryInput) => DeleteLibraryEntryResult;
  readonly composeDraft: (input: {
    readonly environmentId: string;
    readonly entryIds: ReadonlyArray<string>;
    readonly question: string;
    readonly maxTotalChars?: number | undefined;
  }) => ComposeLibraryDraftResult;
}

function parseTagsJson(raw: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function rowToEntry(row: EntryRow): LibraryEntry {
  return {
    id: row.id,
    kind: row.kind as LibraryEntryKind,
    title: row.title,
    url: row.url,
    body: row.body,
    note: row.note,
    tags: parseTagsJson(row.tags_json),
    blobSha256: row.blob_sha256,
    blobBytes: row.blob_bytes,
    pageCount: row.page_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function clampSnippet(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= LIBRARY_SNIPPET_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, LIBRARY_SNIPPET_MAX_CHARS - 1).trimEnd()}…`;
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/gu, '""')}"`;
}

function splitQueryTerms(query: string): ReadonlyArray<string> {
  if (query.length === 0) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const part of query.split(/\s+/u)) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(trimmed);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

function isUniqueUrlConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("UNIQUE constraint failed: entries.url");
}

function validatePages(
  pages: ReadonlyArray<LibraryEntryPage> | undefined,
): ReadonlyArray<LibraryEntryPage> {
  if (!pages || pages.length === 0) return [];
  const seen = new Set<number>();
  const validated: LibraryEntryPage[] = [];
  for (const page of pages) {
    if (!Number.isInteger(page.physicalPage) || page.physicalPage < 1) {
      throw new LibraryValidationError("pages", "Page physicalPage must be a 1-based integer.");
    }
    if (seen.has(page.physicalPage)) {
      throw new LibraryValidationError("pages", `Duplicate physicalPage: ${page.physicalPage}`);
    }
    if (!VALID_PAGE_STATUSES.has(page.extractionStatus)) {
      throw new LibraryValidationError(
        "pages",
        `Invalid page extractionStatus: ${page.extractionStatus}`,
      );
    }
    if (page.text.includes("\u0000")) {
      throw new LibraryValidationError("pages", "Page text must not contain NUL bytes.");
    }
    seen.add(page.physicalPage);
    validated.push({
      physicalPage: page.physicalPage,
      text: page.text,
      extractionStatus: page.extractionStatus,
    });
  }
  return validated;
}

function validateRevision(expectedRevision: number): number {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new LibraryValidationError(
      "expectedRevision",
      "expectedRevision must be a positive integer.",
    );
  }
  return expectedRevision;
}

function chmodPosixBestEffort(targetPath: string, mode: number, isWindows: boolean): void {
  if (isWindows) return;
  try {
    NodeFS.chmodSync(targetPath, mode);
  } catch {
    // Non-fatal on filesystems that disallow chmod.
  }
}

function runInImmediateTransaction<T>(db: NodeSqlite.DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failure after a failed statement.
    }
    throw error;
  }
}

function setupFts(db: NodeSqlite.DatabaseSync): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        title,
        url,
        body,
        note,
        content = 'entries',
        content_rowid = 'rowid',
        tokenize = 'trigram remove_diacritics 1'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entry_pages_fts USING fts5(
        text,
        content = 'entry_pages',
        content_rowid = 'rowid',
        tokenize = 'trigram remove_diacritics 1'
      );
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, url, body, note)
        VALUES (new.rowid, new.title, new.url, new.body, new.note);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, url, body, note)
        VALUES ('delete', old.rowid, old.title, old.url, old.body, old.note);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE OF title, url, body, note ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, url, body, note)
        VALUES ('delete', old.rowid, old.title, old.url, old.body, old.note);
        INSERT INTO entries_fts(rowid, title, url, body, note)
        VALUES (new.rowid, new.title, new.url, new.body, new.note);
      END;
      CREATE TRIGGER IF NOT EXISTS entry_pages_ai AFTER INSERT ON entry_pages BEGIN
        INSERT INTO entry_pages_fts(rowid, text)
        VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS entry_pages_ad AFTER DELETE ON entry_pages BEGIN
        INSERT INTO entry_pages_fts(entry_pages_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS entry_pages_au AFTER UPDATE OF text ON entry_pages BEGIN
        INSERT INTO entry_pages_fts(entry_pages_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO entry_pages_fts(rowid, text)
        VALUES (new.rowid, new.text);
      END;
    `);
    return true;
  } catch {
    return false;
  }
}

export function openLibraryDatabase(options: OpenLibraryDatabaseOptions): LibraryDatabase {
  const { dbPath } = options;
  const isWindows = options.isWindows ?? false;
  // @effect-diagnostics-next-line globalDate:off -- Pure non-Effect storage package defaults to wall-clock Date when no clock is injected.
  const now = options.now ?? (() => new Date());

  if (dbPath !== ":memory:") {
    const parentDir = NodePath.dirname(dbPath);
    NodeFS.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    chmodPosixBestEffort(parentDir, 0o700, isWindows);
  }

  const db = new NodeSqlite.DatabaseSync(dbPath);
  let closed = false;

  try {
    if (dbPath !== ":memory:") {
      chmodPosixBestEffort(dbPath, 0o600, isWindows);
      db.exec("PRAGMA journal_mode = WAL;");
    }
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA synchronous = NORMAL;");

    const versionRow = db.prepare("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    const currentVersion = Number(versionRow?.user_version ?? 0);

    if (currentVersion < SCHEMA_VERSION) {
      runInImmediateTransaction(db, () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS entries (
            rowid INTEGER PRIMARY KEY,
            id TEXT UNIQUE NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT UNIQUE,
            body TEXT NOT NULL,
            note TEXT NOT NULL,
            tags_json TEXT NOT NULL DEFAULT '[]',
            blob_sha256 TEXT,
            blob_bytes INTEGER,
            page_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1
          ) STRICT;

          CREATE TABLE IF NOT EXISTS entry_pages (
            rowid INTEGER PRIMARY KEY,
            entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            physical_page INTEGER NOT NULL CHECK (physical_page >= 1),
            text TEXT NOT NULL,
            extraction_status TEXT NOT NULL,
            UNIQUE(entry_id, physical_page)
          ) STRICT;

          CREATE INDEX IF NOT EXISTS idx_entries_updated_at
            ON entries(updated_at DESC, rowid DESC);
          CREATE INDEX IF NOT EXISTS idx_entries_kind_updated_at
            ON entries(kind, updated_at DESC, rowid DESC);
          CREATE INDEX IF NOT EXISTS idx_entry_pages_entry_page
            ON entry_pages(entry_id, physical_page);

          PRAGMA user_version = ${SCHEMA_VERSION};
        `);
      });
    }

    const ftsEnabled = options.forceDisableFts ? false : setupFts(db);

    const selectEntryByIdStmt = db.prepare(`
      SELECT id, kind, title, url, body, note, tags_json, blob_sha256, blob_bytes,
             page_count, created_at, updated_at, revision
      FROM entries
      WHERE id = ?
    `);

    const selectEntryIdByUrlStmt = db.prepare(`
      SELECT id FROM entries WHERE url = ?
    `);

    const selectPagesByEntryIdStmt = db.prepare(`
      SELECT physical_page, text, extraction_status
      FROM entry_pages
      WHERE entry_id = ?
      ORDER BY physical_page ASC
    `);

    const insertEntryStmt = db.prepare(`
      INSERT INTO entries (
        id, kind, title, url, body, note, tags_json,
        blob_sha256, blob_bytes, page_count, created_at, updated_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    const insertPageStmt = db.prepare(`
      INSERT INTO entry_pages (entry_id, physical_page, text, extraction_status)
      VALUES (?, ?, ?, ?)
    `);

    const updateEntryStmt = db.prepare(`
      UPDATE entries
      SET title = ?, url = ?, body = ?, note = ?, tags_json = ?,
          updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ?
    `);

    const deletePagesByEntryStmt = db.prepare(`
      DELETE FROM entry_pages WHERE entry_id = ?
    `);

    const deleteEntryStmt = db.prepare(`
      DELETE FROM entries WHERE id = ? AND revision = ?
    `);

    const getEntry = (id: string): LibraryEntry | null => {
      const trimmedId = id.trim();
      if (trimmedId.length === 0) return null;
      const row = selectEntryByIdStmt.get(trimmedId) as EntryRow | undefined;
      return row ? rowToEntry(row) : null;
    };

    const getEntryPages = (entryId: string): ReadonlyArray<LibraryEntryPage> => {
      const rows = selectPagesByEntryIdStmt.all(entryId) as unknown as ReadonlyArray<PageRow>;
      return rows.map((row) => ({
        physicalPage: row.physical_page,
        text: row.text,
        extractionStatus: row.extraction_status as LibraryPageExtractionStatus,
      }));
    };

    const saveEntry = (input: SaveLibraryEntryInput): LibraryEntry => {
      const kind = validateLibraryKind(input.kind);
      const title = normalizeLibraryTitle(input.title);
      const url = normalizeLibraryUrl(input.url);
      const body = normalizeLibraryBody(input.body);
      const note = normalizeLibraryNote(input.note);
      const tags = normalizeLibraryTags(input.tags);
      const pages = validatePages(input.pages);
      const pageCount =
        input.pageCount !== undefined
          ? Math.max(0, Math.floor(input.pageCount))
          : pages.length > 0
            ? Math.max(...pages.map((page) => page.physicalPage))
            : 0;
      const blobSha256 = input.blobSha256 ?? null;
      const blobBytes = input.blobBytes ?? null;

      if ((kind === "web" || kind === "wechat") && url === null) {
        throw new LibraryValidationError("url", "Web and WeChat entries require a valid URL.");
      }

      const id = NodeCrypto.randomUUID();
      const timestamp = now().toISOString();

      try {
        runInImmediateTransaction(db, () => {
          if (url !== null) {
            const existing = selectEntryIdByUrlStmt.get(url) as { readonly id: string } | undefined;
            if (existing) {
              throw new LibraryDuplicateUrlError(url, existing.id);
            }
          }
          insertEntryStmt.run(
            id,
            kind,
            title,
            url,
            body,
            note,
            JSON.stringify(tags),
            blobSha256,
            blobBytes,
            pageCount,
            timestamp,
            timestamp,
          );
          for (const page of pages) {
            insertPageStmt.run(id, page.physicalPage, page.text, page.extractionStatus);
          }
        });
      } catch (error) {
        if (error instanceof LibraryDuplicateUrlError) throw error;
        if (url !== null && isUniqueUrlConstraintError(error)) {
          const existing = selectEntryIdByUrlStmt.get(url) as { readonly id: string } | undefined;
          throw new LibraryDuplicateUrlError(url, existing?.id ?? "");
        }
        throw error;
      }

      const saved = getEntry(id);
      if (!saved) {
        throw new LibraryNotFoundError(id);
      }
      return saved;
    };

    const importTextFile = (input: ImportTextFileInput): LibraryEntry => {
      const validated = validateTextImportFile({
        fileName: input.fileName,
        content: input.content,
        title: input.title,
      });
      return saveEntry({
        kind: "file",
        title: validated.title,
        body: validated.body,
        note: input.note,
        tags: input.tags,
      });
    };

    const updateEntry = (input: UpdateLibraryEntryInput): LibraryEntry => {
      const id = input.id.trim();
      if (id.length === 0) {
        throw new LibraryValidationError("id", "Entry ID must not be empty.");
      }
      const expectedRevision = validateRevision(input.expectedRevision);

      const hasTitle = input.title !== undefined;
      const hasUrl = input.url !== undefined;
      const hasBody = input.body !== undefined;
      const hasNote = input.note !== undefined;
      const hasTags = input.tags !== undefined;

      const nextTitle = hasTitle ? normalizeLibraryTitle(input.title!) : undefined;
      const nextUrl = hasUrl ? normalizeLibraryUrl(input.url) : undefined;
      const nextBody = hasBody ? normalizeLibraryBody(input.body) : undefined;
      const nextNote = hasNote ? normalizeLibraryNote(input.note) : undefined;
      const nextTags = hasTags ? normalizeLibraryTags(input.tags) : undefined;

      const timestamp = now().toISOString();

      try {
        runInImmediateTransaction(db, () => {
          const current = selectEntryByIdStmt.get(id) as EntryRow | undefined;
          if (!current) {
            throw new LibraryNotFoundError(id);
          }
          if (current.revision !== expectedRevision) {
            throw new LibraryEditConflictError(id, expectedRevision, current.revision);
          }

          const finalTitle = nextTitle ?? current.title;
          const finalUrl = hasUrl ? nextUrl! : current.url;
          const finalBody = nextBody ?? current.body;
          const finalNote = nextNote ?? current.note;
          const finalTagsJson =
            nextTags !== undefined ? JSON.stringify(nextTags) : current.tags_json;

          if ((current.kind === "web" || current.kind === "wechat") && finalUrl === null) {
            throw new LibraryValidationError("url", "Web and WeChat entries require a valid URL.");
          }

          if (finalUrl !== null && finalUrl !== current.url) {
            const existing = selectEntryIdByUrlStmt.get(finalUrl) as
              | { readonly id: string }
              | undefined;
            if (existing && existing.id !== id) {
              throw new LibraryDuplicateUrlError(finalUrl, existing.id);
            }
          }

          const result = updateEntryStmt.run(
            finalTitle,
            finalUrl,
            finalBody,
            finalNote,
            finalTagsJson,
            timestamp,
            id,
            expectedRevision,
          );
          if (result.changes === 0) {
            const latest = selectEntryByIdStmt.get(id) as EntryRow | undefined;
            if (!latest) throw new LibraryNotFoundError(id);
            throw new LibraryEditConflictError(id, expectedRevision, latest.revision);
          }
        });
      } catch (error) {
        if (
          error instanceof LibraryNotFoundError ||
          error instanceof LibraryEditConflictError ||
          error instanceof LibraryDuplicateUrlError ||
          error instanceof LibraryValidationError
        ) {
          throw error;
        }
        if (
          hasUrl &&
          nextUrl !== null &&
          nextUrl !== undefined &&
          isUniqueUrlConstraintError(error)
        ) {
          const existing = selectEntryIdByUrlStmt.get(nextUrl) as
            | { readonly id: string }
            | undefined;
          throw new LibraryDuplicateUrlError(nextUrl, existing?.id ?? "");
        }
        throw error;
      }

      const updated = getEntry(id);
      if (!updated) {
        throw new LibraryNotFoundError(id);
      }
      return updated;
    };

    const deleteEntry = (input: DeleteLibraryEntryInput): DeleteLibraryEntryResult => {
      const id = input.id.trim();
      if (id.length === 0) {
        throw new LibraryValidationError("id", "Entry ID must not be empty.");
      }
      const expectedRevision = validateRevision(input.expectedRevision);

      runInImmediateTransaction(db, () => {
        const current = selectEntryByIdStmt.get(id) as EntryRow | undefined;
        if (!current) {
          throw new LibraryNotFoundError(id);
        }
        if (current.revision !== expectedRevision) {
          throw new LibraryEditConflictError(id, expectedRevision, current.revision);
        }
        // Explicitly clear child pages before deleting the parent so FTS5 triggers always run cleanly.
        deletePagesByEntryStmt.run(id);
        const result = deleteEntryStmt.run(id, expectedRevision);
        if (result.changes === 0) {
          const latest = selectEntryByIdStmt.get(id) as EntryRow | undefined;
          if (!latest) throw new LibraryNotFoundError(id);
          throw new LibraryEditConflictError(id, expectedRevision, latest.revision);
        }
      });

      return { id, deletedRevision: expectedRevision };
    };

    const listEntries = (input: ListLibraryEntriesInput = {}): ListLibraryEntriesResult => {
      const query = normalizeLibraryQuery(input.query);
      const terms = splitQueryTerms(query);
      const kind = input.kind !== undefined ? validateLibraryKind(input.kind) : undefined;
      const tag = input.tag?.trim() || undefined;
      const rawLimit = input.limit ?? LIBRARY_DEFAULT_LIST_LIMIT;
      const rawOffset = input.offset ?? 0;

      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > LIBRARY_MAX_LIST_LIMIT) {
        throw new LibraryValidationError(
          "limit",
          `limit must be an integer between 1 and ${LIBRARY_MAX_LIST_LIMIT}.`,
        );
      }
      if (!Number.isInteger(rawOffset) || rawOffset < 0) {
        throw new LibraryValidationError("offset", "offset must be a non-negative integer.");
      }

      const whereClauses: string[] = [];
      const whereParams: Array<string | number> = [];

      if (kind !== undefined) {
        whereClauses.push("e.kind = ?");
        whereParams.push(kind);
      }
      if (tag !== undefined) {
        whereClauses.push(
          "EXISTS (SELECT 1 FROM json_each(e.tags_json) WHERE lower(value) = lower(?))",
        );
        whereParams.push(tag);
      }

      const allTermsSupportFts =
        ftsEnabled && terms.length > 0 && terms.every((term) => Array.from(term).length >= 3);
      const searchMode: LibrarySearchMode =
        terms.length === 0 ? "browse" : allTermsSupportFts ? "fts5" : "substring";

      for (const term of terms) {
        const useFtsForTerm = ftsEnabled && Array.from(term).length >= 3;
        if (useFtsForTerm) {
          const ftsExpr = quoteFtsTerm(term);
          whereClauses.push(
            `(e.rowid IN (SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?) OR EXISTS (SELECT 1 FROM entry_pages p JOIN entry_pages_fts pf ON pf.rowid = p.rowid WHERE p.entry_id = e.id AND entry_pages_fts MATCH ?))`,
          );
          whereParams.push(ftsExpr, ftsExpr);
        } else {
          const lowered = term.toLowerCase();
          whereClauses.push(
            `(instr(lower(e.title), ?) > 0 OR instr(lower(COALESCE(e.url, '')), ?) > 0 OR instr(lower(e.body), ?) > 0 OR instr(lower(e.note), ?) > 0 OR EXISTS (SELECT 1 FROM entry_pages p WHERE p.entry_id = e.id AND instr(lower(p.text), ?) > 0))`,
          );
          whereParams.push(lowered, lowered, lowered, lowered, lowered);
        }
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

      const countRow = db
        .prepare(`SELECT COUNT(*) AS total FROM entries e ${whereSql}`)
        .get(...whereParams) as { readonly total: number } | undefined;
      const total = Number(countRow?.total ?? 0);

      if (total === 0 || rawOffset >= total) {
        return { items: [], total, hasMore: false, searchMode };
      }

      const primaryTerm = terms[0]?.toLowerCase() ?? "";
      const snippetSelect =
        primaryTerm.length > 0
          ? `
            CASE
              WHEN instr(lower(e.body), ?) > 0 THEN substr(e.body, max(1, instr(lower(e.body), ?) - 60), ${LIBRARY_SNIPPET_MAX_CHARS + 40})
              ELSE substr(e.body, 1, ${LIBRARY_SNIPPET_MAX_CHARS + 40})
            END AS body_snippet,
            CASE
              WHEN instr(lower(e.note), ?) > 0 THEN substr(e.note, max(1, instr(lower(e.note), ?) - 60), ${LIBRARY_SNIPPET_MAX_CHARS + 40})
              ELSE substr(e.note, 1, ${LIBRARY_SNIPPET_MAX_CHARS + 40})
            END AS note_snippet
          `
          : `
            substr(e.body, 1, ${LIBRARY_SNIPPET_MAX_CHARS + 40}) AS body_snippet,
            substr(e.note, 1, ${LIBRARY_SNIPPET_MAX_CHARS + 40}) AS note_snippet
          `;

      const selectParams: Array<string | number> =
        primaryTerm.length > 0
          ? [
              primaryTerm,
              primaryTerm,
              primaryTerm,
              primaryTerm,
              ...whereParams,
              rawLimit,
              rawOffset,
            ]
          : [...whereParams, rawLimit, rawOffset];

      const rows = db
        .prepare(`
          SELECT
            e.id,
            e.kind,
            e.title,
            e.url,
            e.tags_json,
            ${snippetSelect},
            e.page_count,
            e.created_at,
            e.updated_at,
            e.revision
          FROM entries e
          ${whereSql}
          ORDER BY e.updated_at DESC, e.rowid DESC
          LIMIT ? OFFSET ?
        `)
        .all(...selectParams) as unknown as ReadonlyArray<SummaryRow>;

      const matchedPagesByEntry = new Map<string, number[]>();
      const pageSnippetByEntry = new Map<string, string>();
      if (terms.length > 0 && rows.length > 0) {
        const entryIds = rows.map((row) => row.id);
        const idPlaceholders = entryIds.map(() => "?").join(", ");
        const pageConditions: string[] = [];
        const pageParams: Array<string | number> = [...entryIds];
        for (const term of terms) {
          pageConditions.push("instr(lower(p.text), ?) > 0");
          pageParams.push(term.toLowerCase());
        }
        const matchedPageRows = db
          .prepare(`
            SELECT
              p.entry_id,
              p.physical_page,
              CASE
                WHEN instr(lower(p.text), ?) > 0 THEN substr(p.text, max(1, instr(lower(p.text), ?) - 60), ${LIBRARY_SNIPPET_MAX_CHARS + 40})
                ELSE substr(p.text, 1, ${LIBRARY_SNIPPET_MAX_CHARS + 40})
              END AS page_snippet
            FROM entry_pages p
            WHERE p.entry_id IN (${idPlaceholders})
              AND (${pageConditions.join(" OR ")})
            ORDER BY p.entry_id ASC, p.physical_page ASC
          `)
          .all(primaryTerm, primaryTerm, ...pageParams) as unknown as ReadonlyArray<{
          readonly entry_id: string;
          readonly physical_page: number;
          readonly page_snippet: string;
        }>;
        for (const matched of matchedPageRows) {
          const list = matchedPagesByEntry.get(matched.entry_id) ?? [];
          if (list.length < MAX_MATCHED_PAGES_PER_SUMMARY) {
            list.push(matched.physical_page);
            matchedPagesByEntry.set(matched.entry_id, list);
          }
          if (!pageSnippetByEntry.has(matched.entry_id) && matched.page_snippet.trim().length > 0) {
            pageSnippetByEntry.set(matched.entry_id, matched.page_snippet);
          }
        }
      }

      const items: ReadonlyArray<LibraryEntrySummary> = rows.map((row) => {
        const bodySnippet = clampSnippet(row.body_snippet);
        const notePreview = clampSnippet(row.note_snippet);
        const pageSnippet = pageSnippetByEntry.get(row.id);
        const snippet =
          bodySnippet.length > 0
            ? bodySnippet
            : pageSnippet
              ? clampSnippet(pageSnippet)
              : notePreview;
        return {
          id: row.id,
          kind: row.kind as LibraryEntryKind,
          title: row.title,
          url: row.url,
          tags: parseTagsJson(row.tags_json),
          snippet,
          notePreview,
          matchedPages: matchedPagesByEntry.get(row.id) ?? [],
          pageCount: row.page_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revision: row.revision,
        };
      });

      return {
        items,
        total,
        hasMore: rawOffset + items.length < total,
        searchMode,
      };
    };

    const composeDraft = (input: {
      readonly environmentId: string;
      readonly entryIds: ReadonlyArray<string>;
      readonly question: string;
      readonly maxTotalChars?: number | undefined;
    }): ComposeLibraryDraftResult => {
      const uniqueIds: string[] = [];
      const seen = new Set<string>();
      for (const rawId of input.entryIds) {
        const trimmed = rawId.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;
        seen.add(trimmed);
        uniqueIds.push(trimmed);
      }
      if (uniqueIds.length === 0) {
        throw new LibraryValidationError("entryIds", "Select at least one library entry.");
      }
      if (uniqueIds.length > LIBRARY_MAX_DRAFT_ITEMS) {
        throw new LibraryValidationError(
          "entryIds",
          `At most ${LIBRARY_MAX_DRAFT_ITEMS} library entries can be attached to one draft.`,
        );
      }

      const entries = uniqueIds.map((entryId) => {
        const entry = getEntry(entryId);
        if (!entry) {
          throw new LibraryNotFoundError(entryId);
        }
        const pages = getEntryPages(entryId);
        return {
          ...entry,
          ...(pages.length > 0 ? { pages } : {}),
        };
      });

      return composeLibraryDraft({
        environmentId: input.environmentId,
        question: input.question,
        entries,
        maxTotalChars: input.maxTotalChars,
      });
    };

    const rebuildSearchIndex = (): void => {
      if (!ftsEnabled) return;
      runInImmediateTransaction(db, () => {
        db.exec(`
          INSERT INTO entries_fts(entries_fts) VALUES('rebuild');
          INSERT INTO entry_pages_fts(entry_pages_fts) VALUES('rebuild');
        `);
      });
    };

    const close = (): void => {
      if (closed) return;
      closed = true;
      db.close();
    };

    return {
      dbPath,
      ftsEnabled,
      close,
      rebuildSearchIndex,
      saveEntry,
      importTextFile,
      getEntry,
      getEntryPages,
      listEntries,
      updateEntry,
      deleteEntry,
      composeDraft,
    };
  } catch (error) {
    if (!closed) {
      closed = true;
      try {
        db.close();
      } catch {
        // Ignore close failure while unwinding open error.
      }
    }
    throw error;
  }
}

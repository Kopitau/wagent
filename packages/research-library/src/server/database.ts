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
  LIBRARY_FEED_DEFAULT_DAILY_AI_BUDGET,
  LIBRARY_FEED_DEFAULT_INTERVAL_MINUTES,
  LIBRARY_FEED_DEFAULT_ITEMS_PER_RUN,
  LIBRARY_FEED_KINDS,
  LIBRARY_FEED_MAX_DAILY_AI_BUDGET,
  LIBRARY_FEED_MAX_INTERVAL_MINUTES,
  LIBRARY_FEED_MAX_ITEMS_PER_RUN,
  LIBRARY_FEED_MIN_INTERVAL_MINUTES,
  LIBRARY_MAX_DRAFT_ITEMS,
  LIBRARY_MAX_LIST_LIMIT,
  LIBRARY_MCP_DEFAULT_READ_CHARS,
  LIBRARY_MCP_MAX_READ_CHARS,
  LIBRARY_PAGE_EXTRACTION_STATUSES,
  LIBRARY_SNIPPET_MAX_CHARS,
  LIBRARY_UNTRUSTED_DATA_NOTICE,
  type AppendLibraryNoteIdempotentInput,
  type AppendLibraryNoteIdempotentResult,
  type ComposeLibraryDraftResult,
  type DeleteLibraryEntryInput,
  type DeleteLibraryEntryResult,
  type ImportTextFileInput,
  type IngestLibraryFeedItemInput,
  type IngestLibraryFeedItemResult,
  type LibraryDailyAiBudgetAttempt,
  type LibraryEntry,
  type LibraryEntryKind,
  type LibraryEntryPage,
  type LibraryEntrySummary,
  type LibraryFeed,
  type LibraryFeedKind,
  type LibraryMcpReadItemInput,
  type LibraryMcpReadItemResult,
  type LibraryMcpReadingNoteItem,
  type LibraryMcpReadingNotesInput,
  type LibraryMcpReadingNotesResult,
  type LibraryPageExtractionStatus,
  type LibraryReadingInsight,
  type LibraryReadingParagraph,
  type LibraryReadingQuestion,
  type LibraryReadingState,
  type LibrarySearchMode,
  type ListLibraryEntriesInput,
  type ListLibraryEntriesResult,
  type SaveLibraryEntryInput,
  type UpdateLibraryEntryInput,
  type UpsertLibraryFeedInput,
  type UpsertReadingParagraphInput,
  type UpsertReadingQuestionInput,
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

const SCHEMA_VERSION = 4;
const MAX_QUERY_TERMS = 8;
const MAX_MATCHED_PAGES_PER_SUMMARY = 8;
const VALID_PAGE_STATUSES: ReadonlySet<string> = new Set(LIBRARY_PAGE_EXTRACTION_STATUSES);
const VALID_FEED_KINDS: ReadonlySet<string> = new Set(LIBRARY_FEED_KINDS);

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
  readonly getEntryPages: (
    entryId: string,
    range?: { readonly pageStart?: number | undefined; readonly pageEnd?: number | undefined },
  ) => ReadonlyArray<LibraryEntryPage>;
  readonly countBlobReferences: (sha256: string) => number;
  readonly listReferencedBlobSha256s: () => ReadonlySet<string>;
  readonly listEntries: (input?: ListLibraryEntriesInput) => ListLibraryEntriesResult;
  readonly readEntryForMcp: (
    input: LibraryMcpReadItemInput,
    options?: { readonly blobMissing?: boolean | undefined },
  ) => LibraryMcpReadItemResult;
  readonly updateEntry: (input: UpdateLibraryEntryInput) => LibraryEntry;
  readonly deleteEntry: (input: DeleteLibraryEntryInput) => DeleteLibraryEntryResult;
  readonly composeDraft: (input: {
    readonly environmentId: string;
    readonly entryIds: ReadonlyArray<string>;
    readonly question: string;
    readonly maxTotalChars?: number | undefined;
  }) => ComposeLibraryDraftResult;
  readonly getReadingState: (
    entryId: string,
    options?: { readonly includePages?: boolean | undefined },
  ) => LibraryReadingState;
  readonly setReadingPosition: (entryId: string, physicalPage: number) => number;
  readonly upsertReadingParagraph: (input: UpsertReadingParagraphInput) => LibraryReadingParagraph;
  readonly upsertReadingQuestion: (input: UpsertReadingQuestionInput) => LibraryReadingQuestion;
  readonly deleteReadingQuestion: (entryId: string, questionId: string) => boolean;
  readonly upsertReadingInsight: (input: {
    readonly entryId: string;
    readonly kind: string;
    readonly payloadJson: string;
    readonly modelId?: string | undefined;
  }) => LibraryReadingInsight;
  readonly setReadingPreference: (scopeKey: string, valueJson: string) => void;
  readonly getReadingNotesForMcp: (
    input: LibraryMcpReadingNotesInput,
  ) => LibraryMcpReadingNotesResult;
  readonly appendNoteIdempotent: (
    input: AppendLibraryNoteIdempotentInput,
  ) => AppendLibraryNoteIdempotentResult;
  readonly listFeeds: () => ReadonlyArray<LibraryFeed>;
  readonly getFeed: (id: string) => LibraryFeed | null;
  readonly upsertFeed: (input: UpsertLibraryFeedInput) => LibraryFeed;
  readonly setFeedEnabled: (id: string, enabled: boolean) => LibraryFeed;
  readonly deleteFeed: (id: string) => boolean;
  readonly hasFeedSeenItem: (
    feedId: string,
    externalId: string,
    normalizedUrl: string | null,
  ) => boolean;
  readonly markFeedItemSeen: (
    feedId: string,
    externalId: string,
    normalizedUrl: string | null,
    entryId: string | null,
  ) => void;
  readonly ingestFeedItem: (input: IngestLibraryFeedItemInput) => IngestLibraryFeedItemResult;
  readonly recordFeedRun: (input: {
    readonly feedId: string;
    readonly status: string;
    readonly error: string | null;
    readonly importedCount: number;
  }) => LibraryFeed;
  readonly getDailyAiUsageCount: (usageDate?: string) => number;
  readonly consumeDailyAiBudget: (
    limit: number,
    usageDate?: string,
    feedId?: string,
  ) => LibraryDailyAiBudgetAttempt;
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
    blobMissing: false,
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
          CREATE INDEX IF NOT EXISTS idx_entries_blob_sha256
            ON entries(blob_sha256)
            WHERE blob_sha256 IS NOT NULL;

          CREATE TABLE IF NOT EXISTS reading_positions (
            entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
            physical_page INTEGER NOT NULL CHECK (physical_page >= 1),
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE IF NOT EXISTS reading_paragraphs (
            entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            physical_page INTEGER NOT NULL CHECK (physical_page >= 1),
            anchor TEXT NOT NULL,
            blob_sha256 TEXT,
            anchor_algo_version INTEGER NOT NULL DEFAULT 1,
            quote TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            marked INTEGER NOT NULL DEFAULT 0,
            highlighted INTEGER NOT NULL DEFAULT 0,
            highlight_color TEXT NOT NULL DEFAULT '',
            wkb_kind TEXT NOT NULL DEFAULT '',
            hidden INTEGER NOT NULL DEFAULT 0,
            merged_into TEXT,
            analysis_json TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (entry_id, physical_page, anchor)
          ) STRICT;

          CREATE TABLE IF NOT EXISTS reading_questions (
            id TEXT PRIMARY KEY,
            entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            physical_page INTEGER NOT NULL CHECK (physical_page >= 1),
            anchor TEXT,
            question TEXT NOT NULL,
            self_answer TEXT NOT NULL DEFAULT '',
            answer TEXT NOT NULL DEFAULT '',
            sources_json TEXT NOT NULL DEFAULT '[]',
            model_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE IF NOT EXISTS reading_insights (
            entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            model_id TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (entry_id, kind)
          ) STRICT;

          CREATE TABLE IF NOT EXISTS reading_preferences (
            scope_key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE IF NOT EXISTS library_idempotency (
            key TEXT PRIMARY KEY,
            entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            result_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE INDEX IF NOT EXISTS idx_reading_paragraphs_entry
            ON reading_paragraphs(entry_id, physical_page);
          CREATE INDEX IF NOT EXISTS idx_reading_questions_entry
            ON reading_questions(entry_id, created_at DESC);

          CREATE TABLE IF NOT EXISTS library_feeds (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            url TEXT UNIQUE NOT NULL,
            tags_json TEXT NOT NULL DEFAULT '[]',
            enabled INTEGER NOT NULL DEFAULT 1,
            interval_minutes INTEGER NOT NULL DEFAULT 360,
            max_items_per_run INTEGER NOT NULL DEFAULT 10,
            auto_summarize INTEGER NOT NULL DEFAULT 0,
            ai_instance_id TEXT,
            ai_model TEXT,
            daily_ai_budget INTEGER NOT NULL DEFAULT 5,
            last_run_at TEXT,
            last_status TEXT,
            last_error TEXT,
            last_imported_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE IF NOT EXISTS library_feed_seen (
            feed_id TEXT NOT NULL REFERENCES library_feeds(id) ON DELETE CASCADE,
            external_id TEXT NOT NULL,
            normalized_url TEXT,
            entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
            seen_at TEXT NOT NULL,
            PRIMARY KEY (feed_id, external_id)
          ) STRICT;

          CREATE INDEX IF NOT EXISTS idx_library_feed_seen_url
            ON library_feed_seen(feed_id, normalized_url)
            WHERE normalized_url IS NOT NULL;

          CREATE TABLE IF NOT EXISTS library_ai_daily_usage (
            usage_date TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          ) STRICT;

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

    const selectPagesRangeByEntryIdStmt = db.prepare(`
      SELECT physical_page, text, extraction_status
      FROM entry_pages
      WHERE entry_id = ?
        AND physical_page >= ?
        AND physical_page <= ?
      ORDER BY physical_page ASC
    `);

    const countBlobReferencesStmt = db.prepare(`
      SELECT COUNT(*) AS count
      FROM entries
      WHERE blob_sha256 = ?
    `);

    const selectDistinctBlobSha256Stmt = db.prepare(`
      SELECT DISTINCT blob_sha256
      FROM entries
      WHERE blob_sha256 IS NOT NULL
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

    const getEntryPages = (
      entryId: string,
      range?: { readonly pageStart?: number | undefined; readonly pageEnd?: number | undefined },
    ): ReadonlyArray<LibraryEntryPage> => {
      const hasRange = range?.pageStart !== undefined || range?.pageEnd !== undefined;
      const rows = (hasRange
        ? selectPagesRangeByEntryIdStmt.all(
            entryId,
            Math.max(1, Math.floor(range?.pageStart ?? 1)),
            Math.max(1, Math.floor(range?.pageEnd ?? 1_000_000)),
          )
        : selectPagesByEntryIdStmt.all(entryId)) as unknown as ReadonlyArray<PageRow>;
      return rows.map((row) => ({
        physicalPage: row.physical_page,
        text: row.text,
        extractionStatus: row.extraction_status as LibraryPageExtractionStatus,
      }));
    };

    const countBlobReferences = (sha256: string): number => {
      const row = countBlobReferencesStmt.get(sha256) as { readonly count: number } | undefined;
      return Number(row?.count ?? 0);
    };

    const listReferencedBlobSha256s = (): ReadonlySet<string> => {
      const rows = selectDistinctBlobSha256Stmt.all() as unknown as ReadonlyArray<{
        readonly blob_sha256: string;
      }>;
      return new Set(rows.map((row) => row.blob_sha256));
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

    const readEntryForMcp = (
      input: LibraryMcpReadItemInput,
      options?: { readonly blobMissing?: boolean | undefined },
    ): LibraryMcpReadItemResult => {
      const id = input.id.trim();
      if (id.length === 0) {
        throw new LibraryValidationError("id", "Entry ID must not be empty.");
      }
      const entry = getEntry(id);
      if (!entry) {
        throw new LibraryNotFoundError(id);
      }
      const pageStart = input.pageStart !== undefined ? Math.floor(input.pageStart) : undefined;
      const pageEnd = input.pageEnd !== undefined ? Math.floor(input.pageEnd) : undefined;
      if (pageStart !== undefined && (!Number.isInteger(pageStart) || pageStart < 1)) {
        throw new LibraryValidationError(
          "pageStart",
          "pageStart must be a 1-based positive integer.",
        );
      }
      if (pageEnd !== undefined && (!Number.isInteger(pageEnd) || pageEnd < 1)) {
        throw new LibraryValidationError("pageEnd", "pageEnd must be a 1-based positive integer.");
      }
      if (pageStart !== undefined && pageEnd !== undefined && pageEnd < pageStart) {
        throw new LibraryValidationError(
          "pageEnd",
          "pageEnd must be greater than or equal to pageStart.",
        );
      }
      const maxChars = Math.max(
        256,
        Math.min(
          LIBRARY_MCP_MAX_READ_CHARS,
          Math.floor(input.maxChars ?? LIBRARY_MCP_DEFAULT_READ_CHARS),
        ),
      );

      let budget = maxChars;
      let truncated = false;
      const rawNote = entry.note;
      const noteCap = Math.min(rawNote.length, Math.max(512, Math.floor(maxChars / 4)));
      const note = rawNote.slice(0, noteCap);
      if (note.length < rawNote.length) truncated = true;
      budget = Math.max(0, budget - note.length);

      const selectedPages = getEntryPages(
        entry.id,
        pageStart !== undefined || pageEnd !== undefined ? { pageStart, pageEnd } : undefined,
      );

      const pages: LibraryEntryPage[] = [];
      let body = "";

      if (selectedPages.length > 0) {
        for (const page of selectedPages) {
          if (budget <= 0 && page.text.length > 0) {
            truncated = true;
            break;
          }
          if (page.text.length > budget) {
            pages.push({
              physicalPage: page.physicalPage,
              text: page.text.slice(0, budget),
              extractionStatus: "truncated",
            });
            budget = 0;
            truncated = true;
            break;
          }
          pages.push(page);
          budget -= page.text.length;
        }
      } else {
        if (entry.body.length > budget) {
          body = entry.body.slice(0, budget);
          truncated = true;
        } else {
          body = entry.body;
        }
      }

      return {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        url: entry.url,
        tags: entry.tags,
        note,
        pageCount: entry.pageCount,
        revision: entry.revision,
        blobMissing: options?.blobMissing ?? entry.blobMissing,
        body,
        pages,
        truncated,
        untrustedContentNotice: LIBRARY_UNTRUSTED_DATA_NOTICE,
      };
    };

    const requireEntryExists = (entryId: string): LibraryEntry => {
      const existing = getEntry(entryId);
      if (!existing) {
        throw new LibraryNotFoundError(entryId);
      }
      return existing;
    };

    const getReadingState = (
      entryId: string,
      options?: { readonly includePages?: boolean | undefined },
    ): LibraryReadingState => {
      requireEntryExists(entryId);
      const posRow = db
        .prepare("SELECT physical_page FROM reading_positions WHERE entry_id = ?")
        .get(entryId) as { readonly physical_page: number } | undefined;

      const paragraphRows = db
        .prepare(
          `SELECT entry_id, physical_page, anchor, blob_sha256, anchor_algo_version, quote,
                  note, marked, highlighted, highlight_color, wkb_kind, hidden, merged_into,
                  analysis_json, updated_at
           FROM reading_paragraphs
           WHERE entry_id = ?
           ORDER BY physical_page ASC, updated_at ASC`,
        )
        .all(entryId) as unknown as ReadonlyArray<{
        readonly entry_id: string;
        readonly physical_page: number;
        readonly anchor: string;
        readonly blob_sha256: string | null;
        readonly anchor_algo_version: number;
        readonly quote: string;
        readonly note: string;
        readonly marked: number;
        readonly highlighted: number;
        readonly highlight_color: string;
        readonly wkb_kind: string;
        readonly hidden: number;
        readonly merged_into: string | null;
        readonly analysis_json: string | null;
        readonly updated_at: string;
      }>;

      const questionRows = db
        .prepare(
          `SELECT id, entry_id, physical_page, anchor, question, self_answer, answer,
                  sources_json, model_id, created_at, updated_at
           FROM reading_questions
           WHERE entry_id = ?
           ORDER BY created_at DESC`,
        )
        .all(entryId) as unknown as ReadonlyArray<{
        readonly id: string;
        readonly entry_id: string;
        readonly physical_page: number;
        readonly anchor: string | null;
        readonly question: string;
        readonly self_answer: string;
        readonly answer: string;
        readonly sources_json: string;
        readonly model_id: string;
        readonly created_at: string;
        readonly updated_at: string;
      }>;

      const insightRows = db
        .prepare(
          `SELECT entry_id, kind, payload_json, model_id, updated_at
           FROM reading_insights
           WHERE entry_id = ?`,
        )
        .all(entryId) as unknown as ReadonlyArray<{
        readonly entry_id: string;
        readonly kind: string;
        readonly payload_json: string;
        readonly model_id: string;
        readonly updated_at: string;
      }>;

      const prefRows = db
        .prepare("SELECT scope_key, value_json FROM reading_preferences")
        .all() as unknown as ReadonlyArray<{
        readonly scope_key: string;
        readonly value_json: string;
      }>;
      const preferences: Record<string, string> = {};
      for (const row of prefRows) {
        preferences[row.scope_key] = row.value_json;
      }

      return {
        entryId,
        physicalPage: posRow?.physical_page ?? 1,
        paragraphs: paragraphRows.map((row) => ({
          entryId: row.entry_id,
          physicalPage: row.physical_page,
          anchor: row.anchor,
          blobSha256: row.blob_sha256,
          anchorAlgoVersion: row.anchor_algo_version,
          quote: row.quote,
          note: row.note,
          marked: row.marked !== 0,
          highlighted: row.highlighted !== 0,
          highlightColor: row.highlight_color,
          wkbKind: row.wkb_kind,
          hidden: row.hidden !== 0,
          mergedInto: row.merged_into,
          analysisJson: row.analysis_json,
          updatedAt: row.updated_at,
        })),
        questions: questionRows.map((row) => ({
          id: row.id,
          entryId: row.entry_id,
          physicalPage: row.physical_page,
          anchor: row.anchor,
          question: row.question,
          selfAnswer: row.self_answer,
          answer: row.answer,
          sourcesJson: row.sources_json,
          modelId: row.model_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        insights: insightRows.map((row) => ({
          entryId: row.entry_id,
          kind: row.kind,
          payloadJson: row.payload_json,
          modelId: row.model_id,
          updatedAt: row.updated_at,
        })),
        preferences,
        pages: options?.includePages === false ? [] : getEntryPages(entryId),
      };
    };

    const setReadingPosition = (entryId: string, physicalPage: number): number => {
      const entry = requireEntryExists(entryId);
      const clamped = Math.max(
        1,
        Math.min(entry.pageCount > 0 ? entry.pageCount : 10_000, Math.floor(physicalPage)),
      );
      const timestamp = now().toISOString();
      runInImmediateTransaction(db, () => {
        db.prepare(
          `INSERT INTO reading_positions (entry_id, physical_page, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(entry_id) DO UPDATE SET
             physical_page = excluded.physical_page,
             updated_at = excluded.updated_at`,
        ).run(entryId, clamped, timestamp);
      });
      return clamped;
    };

    const upsertReadingParagraph = (
      input: UpsertReadingParagraphInput,
    ): LibraryReadingParagraph => {
      const entry = requireEntryExists(input.entryId);
      if (!Number.isInteger(input.physicalPage) || input.physicalPage < 1) {
        throw new LibraryValidationError("physicalPage", "physicalPage must be >= 1.");
      }
      const anchor = input.anchor.trim();
      if (!anchor || anchor.length > 128) {
        throw new LibraryValidationError("anchor", "anchor must be 1-128 chars.");
      }
      const timestamp = now().toISOString();

      return runInImmediateTransaction(db, () => {
        const existing = db
          .prepare(
            `SELECT blob_sha256, anchor_algo_version, quote, note, marked, highlighted,
                    highlight_color, wkb_kind, hidden, merged_into, analysis_json
             FROM reading_paragraphs
             WHERE entry_id = ? AND physical_page = ? AND anchor = ?`,
          )
          .get(input.entryId, input.physicalPage, anchor) as
          | {
              readonly blob_sha256: string | null;
              readonly anchor_algo_version: number;
              readonly quote: string;
              readonly note: string;
              readonly marked: number;
              readonly highlighted: number;
              readonly highlight_color: string;
              readonly wkb_kind: string;
              readonly hidden: number;
              readonly merged_into: string | null;
              readonly analysis_json: string | null;
            }
          | undefined;

        const next: LibraryReadingParagraph = {
          entryId: input.entryId,
          physicalPage: input.physicalPage,
          anchor,
          blobSha256:
            input.blobSha256 !== undefined
              ? input.blobSha256
              : (existing?.blob_sha256 ?? entry.blobSha256),
          anchorAlgoVersion: input.anchorAlgoVersion ?? existing?.anchor_algo_version ?? 1,
          quote: input.quote.slice(0, 8_000),
          note:
            input.note !== undefined ? normalizeLibraryNote(input.note) : (existing?.note ?? ""),
          marked:
            input.marked !== undefined ? input.marked : existing ? existing.marked !== 0 : false,
          highlighted:
            input.highlighted !== undefined
              ? input.highlighted
              : existing
                ? existing.highlighted !== 0
                : false,
          highlightColor:
            input.highlightColor !== undefined
              ? input.highlightColor.slice(0, 32)
              : (existing?.highlight_color ?? ""),
          wkbKind:
            input.wkbKind !== undefined ? input.wkbKind.slice(0, 16) : (existing?.wkb_kind ?? ""),
          hidden:
            input.hidden !== undefined ? input.hidden : existing ? existing.hidden !== 0 : false,
          mergedInto:
            input.mergedInto !== undefined ? input.mergedInto : (existing?.merged_into ?? null),
          analysisJson:
            input.analysisJson !== undefined
              ? input.analysisJson
              : (existing?.analysis_json ?? null),
          updatedAt: timestamp,
        };

        db.prepare(
          `INSERT INTO reading_paragraphs (
             entry_id, physical_page, anchor, blob_sha256, anchor_algo_version, quote,
             note, marked, highlighted, highlight_color, wkb_kind, hidden, merged_into,
             analysis_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, physical_page, anchor) DO UPDATE SET
             blob_sha256 = excluded.blob_sha256,
             anchor_algo_version = excluded.anchor_algo_version,
             quote = excluded.quote,
             note = excluded.note,
             marked = excluded.marked,
             highlighted = excluded.highlighted,
             highlight_color = excluded.highlight_color,
             wkb_kind = excluded.wkb_kind,
             hidden = excluded.hidden,
             merged_into = excluded.merged_into,
             analysis_json = excluded.analysis_json,
             updated_at = excluded.updated_at`,
        ).run(
          next.entryId,
          next.physicalPage,
          next.anchor,
          next.blobSha256,
          next.anchorAlgoVersion,
          next.quote,
          next.note,
          next.marked ? 1 : 0,
          next.highlighted ? 1 : 0,
          next.highlightColor,
          next.wkbKind,
          next.hidden ? 1 : 0,
          next.mergedInto,
          next.analysisJson,
          next.updatedAt,
        );
        return next;
      });
    };

    const upsertReadingQuestion = (input: UpsertReadingQuestionInput): LibraryReadingQuestion => {
      requireEntryExists(input.entryId);
      const question = input.question.trim();
      if (!question || question.length > 4_000) {
        throw new LibraryValidationError("question", "question must be 1-4000 chars.");
      }
      if (!Number.isInteger(input.physicalPage) || input.physicalPage < 1) {
        throw new LibraryValidationError("physicalPage", "physicalPage must be >= 1.");
      }
      const id = input.id?.trim() || NodeCrypto.randomUUID();
      const timestamp = now().toISOString();

      return runInImmediateTransaction(db, () => {
        const existing = db
          .prepare(
            "SELECT entry_id, created_at, self_answer, answer, sources_json, model_id FROM reading_questions WHERE id = ?",
          )
          .get(id) as
          | {
              readonly entry_id: string;
              readonly created_at: string;
              readonly self_answer: string;
              readonly answer: string;
              readonly sources_json: string;
              readonly model_id: string;
            }
          | undefined;

        if (existing && existing.entry_id !== input.entryId) {
          throw new LibraryValidationError(
            "id",
            "Question ID belongs to a different library entry.",
          );
        }

        const next: LibraryReadingQuestion = {
          id,
          entryId: input.entryId,
          physicalPage: input.physicalPage,
          anchor: input.anchor ?? null,
          question,
          selfAnswer:
            input.selfAnswer !== undefined
              ? input.selfAnswer.slice(0, 16_000)
              : (existing?.self_answer ?? ""),
          answer:
            input.answer !== undefined ? input.answer.slice(0, 48_000) : (existing?.answer ?? ""),
          sourcesJson: input.sourcesJson ?? existing?.sources_json ?? "[]",
          modelId: input.modelId ?? existing?.model_id ?? "",
          createdAt: existing?.created_at ?? timestamp,
          updatedAt: timestamp,
        };

        db.prepare(
          `INSERT INTO reading_questions (
             id, entry_id, physical_page, anchor, question, self_answer, answer,
             sources_json, model_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             physical_page = excluded.physical_page,
             anchor = excluded.anchor,
             question = excluded.question,
             self_answer = excluded.self_answer,
             answer = excluded.answer,
             sources_json = excluded.sources_json,
             model_id = excluded.model_id,
             updated_at = excluded.updated_at`,
        ).run(
          next.id,
          next.entryId,
          next.physicalPage,
          next.anchor,
          next.question,
          next.selfAnswer,
          next.answer,
          next.sourcesJson,
          next.modelId,
          next.createdAt,
          next.updatedAt,
        );
        return next;
      });
    };

    const deleteReadingQuestion = (entryId: string, questionId: string): boolean => {
      requireEntryExists(entryId);
      const res = db
        .prepare("DELETE FROM reading_questions WHERE id = ? AND entry_id = ?")
        .run(questionId, entryId);
      return Number(res.changes) > 0;
    };

    const upsertReadingInsight = (input: {
      readonly entryId: string;
      readonly kind: string;
      readonly payloadJson: string;
      readonly modelId?: string | undefined;
    }): LibraryReadingInsight => {
      requireEntryExists(input.entryId);
      const kind = input.kind.trim();
      if (!kind || kind.length > 64) {
        throw new LibraryValidationError("kind", "insight kind must be 1-64 chars.");
      }
      const timestamp = now().toISOString();
      const modelId = input.modelId ?? "";
      runInImmediateTransaction(db, () => {
        db.prepare(
          `INSERT INTO reading_insights (entry_id, kind, payload_json, model_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, kind) DO UPDATE SET
             payload_json = excluded.payload_json,
             model_id = excluded.model_id,
             updated_at = excluded.updated_at`,
        ).run(input.entryId, kind, input.payloadJson, modelId, timestamp);
      });
      return {
        entryId: input.entryId,
        kind,
        payloadJson: input.payloadJson,
        modelId,
        updatedAt: timestamp,
      };
    };

    const setReadingPreference = (scopeKey: string, valueJson: string): void => {
      const key = scopeKey.trim();
      if (!key || key.length > 128) {
        throw new LibraryValidationError("scopeKey", "scopeKey must be 1-128 chars.");
      }
      const timestamp = now().toISOString();
      runInImmediateTransaction(db, () => {
        db.prepare(
          `INSERT INTO reading_preferences (scope_key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(scope_key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        ).run(key, valueJson, timestamp);
      });
    };

    const getReadingNotesForMcp = (
      input: LibraryMcpReadingNotesInput,
    ): LibraryMcpReadingNotesResult => {
      const entry = requireEntryExists(input.id);
      const cursor = Math.max(0, Math.floor(input.cursor ?? 0));
      const maxChars = Math.max(
        256,
        Math.min(
          LIBRARY_MCP_MAX_READ_CHARS,
          Math.floor(input.maxChars ?? LIBRARY_MCP_DEFAULT_READ_CHARS),
        ),
      );
      const includeCards = input.includeCards ?? true;

      const totalRow = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM reading_paragraphs
           WHERE entry_id = ?
             AND (note != '' OR marked = 1 OR highlighted = 1 OR analysis_json IS NOT NULL)`,
        )
        .get(entry.id) as { readonly count: number } | undefined;
      const totalItems = Number(totalRow?.count ?? 0);

      const pageLimit = 200;
      const rows = db
        .prepare(
          `SELECT physical_page, anchor, quote, note, marked, highlighted, wkb_kind, analysis_json
           FROM reading_paragraphs
           WHERE entry_id = ?
             AND (note != '' OR marked = 1 OR highlighted = 1 OR analysis_json IS NOT NULL)
           ORDER BY physical_page ASC, updated_at ASC
           LIMIT ? OFFSET ?`,
        )
        .all(entry.id, pageLimit, cursor) as unknown as ReadonlyArray<{
        readonly physical_page: number;
        readonly anchor: string;
        readonly quote: string;
        readonly note: string;
        readonly marked: number;
        readonly highlighted: number;
        readonly wkb_kind: string;
        readonly analysis_json: string | null;
      }>;

      const items: LibraryMcpReadingNoteItem[] = [];
      let budget = maxChars;
      let truncated = false;
      let entryNote = entry.note;
      if (entryNote.length > Math.floor(budget / 3)) {
        entryNote = entryNote.slice(0, Math.floor(budget / 3));
        truncated = true;
      }
      budget -= entryNote.length;

      let consumedInBatch = 0;
      for (; consumedInBatch < rows.length; consumedInBatch += 1) {
        const row = rows[consumedInBatch]!;
        let cardSummary: string | null = null;
        if (includeCards && row.analysis_json) {
          try {
            const parsed = JSON.parse(row.analysis_json) as { summary?: unknown };
            if (typeof parsed.summary === "string" && parsed.summary.trim()) {
              cardSummary = parsed.summary.trim();
            }
          } catch {
            // Ignore malformed analysis JSON.
          }
        }
        let quote = row.quote.slice(0, 600);
        let note = row.note;
        const overhead = 48;
        const rawItemCost = quote.length + note.length + (cardSummary?.length ?? 0) + overhead;
        if (items.length > 0 && rawItemCost > budget) {
          truncated = true;
          break;
        }
        if (rawItemCost > budget) {
          // First item exceeds remaining budget: clamp quote, note, and cardSummary to fit maxChars.
          truncated = true;
          let availableTextChars = Math.max(32, budget - overhead);
          if (quote.length > Math.floor(availableTextChars / 2)) {
            quote = quote.slice(0, Math.floor(availableTextChars / 2));
          }
          availableTextChars = Math.max(0, availableTextChars - quote.length);
          if (cardSummary && cardSummary.length > Math.floor(availableTextChars / 2)) {
            cardSummary = cardSummary.slice(0, Math.floor(availableTextChars / 2));
          }
          availableTextChars = Math.max(0, availableTextChars - (cardSummary?.length ?? 0));
          if (note.length > availableTextChars) {
            note = note.slice(0, availableTextChars);
          }
        }
        const finalCost = quote.length + note.length + (cardSummary?.length ?? 0) + overhead;
        items.push({
          physicalPage: row.physical_page,
          anchor: row.anchor,
          quote,
          note,
          marked: row.marked !== 0,
          highlighted: row.highlighted !== 0,
          wkbKind: row.wkb_kind,
          cardSummary,
        });
        budget = Math.max(0, budget - finalCost);
      }

      const nextIndex = cursor + consumedInBatch;
      return {
        entryId: entry.id,
        title: entry.title,
        entryNote,
        items,
        nextCursor: nextIndex < totalItems ? nextIndex : null,
        totalItems,
        truncated: truncated || nextIndex < totalItems,
        untrustedContentNotice: LIBRARY_UNTRUSTED_DATA_NOTICE,
      };
    };

    const appendNoteIdempotent = (
      input: AppendLibraryNoteIdempotentInput,
    ): AppendLibraryNoteIdempotentResult => {
      const idempotencyKey = input.idempotencyKey.trim();
      if (!idempotencyKey || idempotencyKey.length > 128) {
        throw new LibraryValidationError(
          "idempotencyKey",
          "idempotencyKey must be a non-empty string up to 128 chars.",
        );
      }
      const addition = input.text.trim();
      if (!addition) {
        throw new LibraryValidationError("text", "Appended note text must not be empty.");
      }

      return runInImmediateTransaction(db, () => {
        const existingReceipt = db
          .prepare("SELECT entry_id FROM library_idempotency WHERE key = ?")
          .get(idempotencyKey) as { readonly entry_id: string } | undefined;

        if (existingReceipt) {
          if (existingReceipt.entry_id !== input.entryId) {
            throw new LibraryValidationError(
              "idempotencyKey",
              "idempotencyKey was already used for a different entry.",
            );
          }
          const latest = requireEntryExists(input.entryId);
          return { entry: latest, deduplicated: true };
        }

        const current = requireEntryExists(input.entryId);
        if (
          input.expectedRevision !== undefined &&
          current.revision !== validateRevision(input.expectedRevision)
        ) {
          throw new LibraryEditConflictError(current.id, input.expectedRevision, current.revision);
        }

        const mergedNote = normalizeLibraryNote(
          current.note.trim().length > 0 ? `${current.note.trimEnd()}\n\n${addition}` : addition,
        );
        const timestamp = now().toISOString();
        const nextRevision = current.revision + 1;

        db.prepare(
          `UPDATE entries
           SET note = ?, updated_at = ?, revision = ?
           WHERE id = ?`,
        ).run(mergedNote, timestamp, nextRevision, current.id);

        const updated: LibraryEntry = {
          ...current,
          note: mergedNote,
          updatedAt: timestamp,
          revision: nextRevision,
        };

        db.prepare(
          `INSERT INTO library_idempotency (key, entry_id, result_json, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(idempotencyKey, current.id, JSON.stringify({ revision: nextRevision }), timestamp);

        return { entry: updated, deduplicated: false };
      });
    };

    interface FeedRow {
      readonly id: string;
      readonly name: string;
      readonly kind: string;
      readonly url: string;
      readonly tags_json: string;
      readonly enabled: number;
      readonly interval_minutes: number;
      readonly max_items_per_run: number;
      readonly auto_summarize: number;
      readonly ai_instance_id: string | null;
      readonly ai_model: string | null;
      readonly daily_ai_budget: number;
      readonly last_run_at: string | null;
      readonly last_status: string | null;
      readonly last_error: string | null;
      readonly last_imported_count: number;
      readonly created_at: string;
      readonly updated_at: string;
    }

    const rowToFeed = (row: FeedRow): LibraryFeed => ({
      id: row.id,
      name: row.name,
      kind: (VALID_FEED_KINDS.has(row.kind) ? row.kind : "rss") as LibraryFeedKind,
      url: row.url,
      tags: parseTagsJson(row.tags_json),
      enabled: row.enabled !== 0,
      intervalMinutes: row.interval_minutes,
      maxItemsPerRun: row.max_items_per_run,
      autoSummarize: row.auto_summarize !== 0,
      aiInstanceId: row.ai_instance_id,
      aiModel: row.ai_model,
      dailyAiBudget: row.daily_ai_budget,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
      lastImportedCount: row.last_imported_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

    const listFeeds = (): ReadonlyArray<LibraryFeed> => {
      const rows = db
        .prepare(
          `SELECT id, name, kind, url, tags_json, enabled, interval_minutes, max_items_per_run,
                  auto_summarize, ai_instance_id, ai_model, daily_ai_budget,
                  last_run_at, last_status, last_error, last_imported_count, created_at, updated_at
           FROM library_feeds
           ORDER BY updated_at DESC, id ASC`,
        )
        .all() as unknown as ReadonlyArray<FeedRow>;
      return rows.map(rowToFeed);
    };

    const getFeed = (id: string): LibraryFeed | null => {
      const trimmed = id.trim();
      if (!trimmed) return null;
      const row = db
        .prepare(
          `SELECT id, name, kind, url, tags_json, enabled, interval_minutes, max_items_per_run,
                  auto_summarize, ai_instance_id, ai_model, daily_ai_budget,
                  last_run_at, last_status, last_error, last_imported_count, created_at, updated_at
           FROM library_feeds
           WHERE id = ?`,
        )
        .get(trimmed) as FeedRow | undefined;
      return row ? rowToFeed(row) : null;
    };

    const upsertFeed = (input: UpsertLibraryFeedInput): LibraryFeed => {
      const name = input.name.trim();
      if (!name || name.length > 200) {
        throw new LibraryValidationError("name", "Feed name must be 1-200 characters.");
      }
      if (!VALID_FEED_KINDS.has(input.kind)) {
        throw new LibraryValidationError("kind", "Feed kind must be 'rss' or 'arxiv'.");
      }
      const normalizedUrl = normalizeLibraryUrl(input.url);
      if (!normalizedUrl) {
        throw new LibraryValidationError("url", "Feed URL must be a valid http or https URL.");
      }
      const tags = normalizeLibraryTags(input.tags);
      const intervalMinutes = Math.floor(
        input.intervalMinutes ?? LIBRARY_FEED_DEFAULT_INTERVAL_MINUTES,
      );
      if (
        !Number.isInteger(intervalMinutes) ||
        intervalMinutes < LIBRARY_FEED_MIN_INTERVAL_MINUTES ||
        intervalMinutes > LIBRARY_FEED_MAX_INTERVAL_MINUTES
      ) {
        throw new LibraryValidationError(
          "intervalMinutes",
          `intervalMinutes must be between ${LIBRARY_FEED_MIN_INTERVAL_MINUTES} and ${LIBRARY_FEED_MAX_INTERVAL_MINUTES}.`,
        );
      }
      const maxItemsPerRun = Math.floor(input.maxItemsPerRun ?? LIBRARY_FEED_DEFAULT_ITEMS_PER_RUN);
      if (
        !Number.isInteger(maxItemsPerRun) ||
        maxItemsPerRun < 1 ||
        maxItemsPerRun > LIBRARY_FEED_MAX_ITEMS_PER_RUN
      ) {
        throw new LibraryValidationError(
          "maxItemsPerRun",
          `maxItemsPerRun must be between 1 and ${LIBRARY_FEED_MAX_ITEMS_PER_RUN}.`,
        );
      }
      const autoSummarize = input.autoSummarize === true;
      const aiInstanceId = input.aiInstanceId?.trim() || null;
      const aiModel = input.aiModel?.trim() || null;
      if (autoSummarize && (!aiInstanceId || !aiModel)) {
        throw new LibraryValidationError(
          "aiModel",
          "Explicit aiInstanceId and aiModel are required when autoSummarize is enabled.",
        );
      }
      const dailyAiBudget = Math.floor(input.dailyAiBudget ?? LIBRARY_FEED_DEFAULT_DAILY_AI_BUDGET);
      if (
        !Number.isInteger(dailyAiBudget) ||
        dailyAiBudget < 0 ||
        dailyAiBudget > LIBRARY_FEED_MAX_DAILY_AI_BUDGET
      ) {
        throw new LibraryValidationError(
          "dailyAiBudget",
          `dailyAiBudget must be between 0 and ${LIBRARY_FEED_MAX_DAILY_AI_BUDGET}.`,
        );
      }

      const timestamp = now().toISOString();
      return runInImmediateTransaction(db, () => {
        const existing = input.id?.trim() ? getFeed(input.id.trim()) : null;
        const id = existing ? existing.id : input.id?.trim() || NodeCrypto.randomUUID();
        const enabled = input.enabled ?? existing?.enabled ?? true;

        const duplicateUrl = db
          .prepare("SELECT id FROM library_feeds WHERE url = ? AND id != ?")
          .get(normalizedUrl, id) as { readonly id: string } | undefined;
        if (duplicateUrl) {
          throw new LibraryDuplicateUrlError(normalizedUrl, duplicateUrl.id);
        }

        if (existing) {
          db.prepare(
            `UPDATE library_feeds
             SET name = ?, kind = ?, url = ?, tags_json = ?, enabled = ?,
                 interval_minutes = ?, max_items_per_run = ?, auto_summarize = ?,
                 ai_instance_id = ?, ai_model = ?, daily_ai_budget = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            name,
            input.kind,
            normalizedUrl,
            JSON.stringify(tags),
            enabled ? 1 : 0,
            intervalMinutes,
            maxItemsPerRun,
            autoSummarize ? 1 : 0,
            aiInstanceId,
            aiModel,
            dailyAiBudget,
            timestamp,
            id,
          );
        } else {
          db.prepare(
            `INSERT INTO library_feeds (
               id, name, kind, url, tags_json, enabled, interval_minutes, max_items_per_run,
               auto_summarize, ai_instance_id, ai_model, daily_ai_budget,
               last_run_at, last_status, last_error, last_imported_count, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`,
          ).run(
            id,
            name,
            input.kind,
            normalizedUrl,
            JSON.stringify(tags),
            enabled ? 1 : 0,
            intervalMinutes,
            maxItemsPerRun,
            autoSummarize ? 1 : 0,
            aiInstanceId,
            aiModel,
            dailyAiBudget,
            timestamp,
            timestamp,
          );
        }

        return getFeed(id)!;
      });
    };

    const setFeedEnabled = (id: string, enabled: boolean): LibraryFeed => {
      const existing = getFeed(id);
      if (!existing) {
        throw new LibraryNotFoundError(id);
      }
      const timestamp = now().toISOString();
      runInImmediateTransaction(db, () => {
        db.prepare(
          `UPDATE library_feeds
           SET enabled = ?, updated_at = ?
           WHERE id = ?`,
        ).run(enabled ? 1 : 0, timestamp, existing.id);
      });
      return getFeed(existing.id)!;
    };

    const deleteFeed = (id: string): boolean => {
      const trimmed = id.trim();
      if (!trimmed) return false;
      return runInImmediateTransaction(db, () => {
        const result = db.prepare("DELETE FROM library_feeds WHERE id = ?").run(trimmed);
        return Number(result.changes) > 0;
      });
    };

    const hasFeedSeenItem = (
      feedId: string,
      externalId: string,
      normalizedUrl: string | null,
    ): boolean => {
      const byExternalId = db
        .prepare("SELECT 1 FROM library_feed_seen WHERE feed_id = ? AND external_id = ?")
        .get(feedId, externalId);
      if (byExternalId) return true;

      if (normalizedUrl) {
        const bySeenUrl = db
          .prepare("SELECT 1 FROM library_feed_seen WHERE feed_id = ? AND normalized_url = ?")
          .get(feedId, normalizedUrl);
        if (bySeenUrl) return true;

        const existingEntry = selectEntryIdByUrlStmt.get(normalizedUrl) as
          | { readonly id: string }
          | undefined;
        if (existingEntry) return true;
      }
      return false;
    };

    const markFeedItemSeen = (
      feedId: string,
      externalId: string,
      normalizedUrl: string | null,
      entryId: string | null,
    ): void => {
      const timestamp = now().toISOString();
      runInImmediateTransaction(db, () => {
        db.prepare(
          `INSERT INTO library_feed_seen (feed_id, external_id, normalized_url, entry_id, seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(feed_id, external_id) DO UPDATE SET
             normalized_url = COALESCE(excluded.normalized_url, library_feed_seen.normalized_url),
             entry_id = COALESCE(excluded.entry_id, library_feed_seen.entry_id),
             seen_at = excluded.seen_at`,
        ).run(feedId, externalId.slice(0, 512), normalizedUrl, entryId, timestamp);
      });
    };

    const ingestFeedItem = (input: IngestLibraryFeedItemInput): IngestLibraryFeedItemResult => {
      const title = normalizeLibraryTitle(input.title);
      const normalizedUrl =
        input.url !== null && input.url.trim().length > 0 ? normalizeLibraryUrl(input.url) : null;
      if (input.url !== null && input.url.trim().length > 0 && normalizedUrl === null) {
        throw new LibraryValidationError("url", "Feed item URL is invalid.");
      }
      const kind: LibraryEntryKind = normalizedUrl !== null ? "web" : "note";
      const body = normalizeLibraryBody(input.body);
      const tags = normalizeLibraryTags(input.tags);
      const externalId = input.externalId.trim().slice(0, 512);
      if (!externalId) {
        throw new LibraryValidationError("externalId", "Feed item externalId must not be empty.");
      }

      const timestamp = now().toISOString();
      const upsertSeenStmt = db.prepare(
        `INSERT INTO library_feed_seen (feed_id, external_id, normalized_url, entry_id, seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(feed_id, external_id) DO UPDATE SET
           normalized_url = COALESCE(excluded.normalized_url, library_feed_seen.normalized_url),
           entry_id = COALESCE(excluded.entry_id, library_feed_seen.entry_id),
           seen_at = excluded.seen_at`,
      );

      return runInImmediateTransaction(db, (): IngestLibraryFeedItemResult => {
        const feedRow = db
          .prepare("SELECT enabled FROM library_feeds WHERE id = ?")
          .get(input.feedId) as { readonly enabled: number } | undefined;
        if (!feedRow || feedRow.enabled === 0) {
          return { status: "paused_or_missing" };
        }

        const seenByExternal = db
          .prepare("SELECT entry_id FROM library_feed_seen WHERE feed_id = ? AND external_id = ?")
          .get(input.feedId, externalId) as { readonly entry_id: string | null } | undefined;
        if (seenByExternal) {
          return { status: "deduplicated", existingEntryId: seenByExternal.entry_id };
        }

        if (normalizedUrl !== null) {
          const seenByUrl = db
            .prepare(
              "SELECT entry_id FROM library_feed_seen WHERE feed_id = ? AND normalized_url = ?",
            )
            .get(input.feedId, normalizedUrl) as { readonly entry_id: string | null } | undefined;
          if (seenByUrl) {
            upsertSeenStmt.run(
              input.feedId,
              externalId,
              normalizedUrl,
              seenByUrl.entry_id,
              timestamp,
            );
            return { status: "deduplicated", existingEntryId: seenByUrl.entry_id };
          }

          const existingEntry = selectEntryIdByUrlStmt.get(normalizedUrl) as
            | { readonly id: string }
            | undefined;
          if (existingEntry) {
            upsertSeenStmt.run(
              input.feedId,
              externalId,
              normalizedUrl,
              existingEntry.id,
              timestamp,
            );
            return { status: "deduplicated", existingEntryId: existingEntry.id };
          }
        }

        const newId = NodeCrypto.randomUUID();
        insertEntryStmt.run(
          newId,
          kind,
          title,
          normalizedUrl,
          body,
          "",
          JSON.stringify(tags),
          null,
          null,
          0,
          timestamp,
          timestamp,
        );
        upsertSeenStmt.run(input.feedId, externalId, normalizedUrl, newId, timestamp);
        const created = selectEntryByIdStmt.get(newId) as EntryRow | undefined;
        if (!created) {
          throw new LibraryNotFoundError(newId);
        }
        return { status: "imported", entry: rowToEntry(created) };
      });
    };

    const recordFeedRun = (input: {
      readonly feedId: string;
      readonly status: string;
      readonly error: string | null;
      readonly importedCount: number;
    }): LibraryFeed => {
      const existing = getFeed(input.feedId);
      if (!existing) {
        throw new LibraryNotFoundError(input.feedId);
      }
      const timestamp = now().toISOString();
      runInImmediateTransaction(db, () => {
        db.prepare(
          `UPDATE library_feeds
           SET last_run_at = ?, last_status = ?, last_error = ?, last_imported_count = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          timestamp,
          input.status.slice(0, 64),
          input.error ? input.error.slice(0, 400) : null,
          Math.max(0, Math.floor(input.importedCount)),
          timestamp,
          existing.id,
        );
      });
      return getFeed(existing.id)!;
    };

    const resolveUsageDate = (usageDate?: string): string => {
      const trimmed = usageDate?.trim();
      if (trimmed && /^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) return trimmed;
      return now().toISOString().slice(0, 10);
    };

    const getDailyAiUsageCount = (usageDate?: string): number => {
      const date = resolveUsageDate(usageDate);
      const row = db
        .prepare("SELECT count FROM library_ai_daily_usage WHERE usage_date = ?")
        .get(date) as { readonly count: number } | undefined;
      return Number(row?.count ?? 0);
    };

    const consumeDailyAiBudget = (
      limit: number,
      usageDate?: string,
      feedId?: string,
    ): LibraryDailyAiBudgetAttempt => {
      const date = resolveUsageDate(usageDate);
      const clampedLimit = Math.max(0, Math.floor(limit));
      const timestamp = now().toISOString();
      return runInImmediateTransaction(db, () => {
        const row = db
          .prepare("SELECT count FROM library_ai_daily_usage WHERE usage_date = ?")
          .get(date) as { readonly count: number } | undefined;
        const current = Number(row?.count ?? 0);
        if (feedId !== undefined) {
          const feedRow = db
            .prepare("SELECT enabled FROM library_feeds WHERE id = ?")
            .get(feedId) as { readonly enabled: number } | undefined;
          if (!feedRow || feedRow.enabled === 0) {
            return { allowed: false, usedCount: current, usageDate: date };
          }
        }
        if (current >= clampedLimit) {
          return { allowed: false, usedCount: current, usageDate: date };
        }
        const nextCount = current + 1;
        db.prepare(
          `INSERT INTO library_ai_daily_usage (usage_date, count, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(usage_date) DO UPDATE SET
             count = excluded.count,
             updated_at = excluded.updated_at`,
        ).run(date, nextCount, timestamp);
        return { allowed: true, usedCount: nextCount, usageDate: date };
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
      countBlobReferences,
      listReferencedBlobSha256s,
      listEntries,
      readEntryForMcp,
      updateEntry,
      deleteEntry,
      composeDraft,
      getReadingState,
      setReadingPosition,
      upsertReadingParagraph,
      upsertReadingQuestion,
      deleteReadingQuestion,
      upsertReadingInsight,
      setReadingPreference,
      getReadingNotesForMcp,
      appendNoteIdempotent,
      listFeeds,
      getFeed,
      upsertFeed,
      setFeedEnabled,
      deleteFeed,
      hasFeedSeenItem,
      markFeedItemSeen,
      ingestFeedItem,
      recordFeedRun,
      getDailyAiUsageCount,
      consumeDailyAiBudget,
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

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure non-Effect package test manages temp SQLite directories directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure non-Effect package test joins temp SQLite paths directly.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  LIBRARY_MAX_BODY_CHARS,
  LIBRARY_MAX_DRAFT_CHARS,
  LIBRARY_MAX_TITLE_CHARS,
  LIBRARY_SNIPPET_MAX_CHARS,
  LibraryDuplicateUrlError,
  LibraryEditConflictError,
  LibraryNotFoundError,
  LibraryValidationError,
  composeLibraryDraft,
  decodeUtf8TextBytes,
  normalizeLibraryUrl,
} from "./index.ts";
import { openLibraryDatabase, type LibraryDatabase } from "./server/index.ts";

const opened: LibraryDatabase[] = [];
const tempDirs: string[] = [];

function createTestDb(options?: {
  readonly forceDisableFts?: boolean;
  readonly fileBacked?: boolean;
}) {
  let dbPath = ":memory:";
  if (options?.fileBacked) {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-library-test-"));
    tempDirs.push(dir);
    dbPath = NodePath.join(dir, "research-library", "library.sqlite");
  }
  let tick = 0;
  const db = openLibraryDatabase({
    dbPath,
    forceDisableFts: options?.forceDisableFts,
    // @effect-diagnostics-next-line globalDate:off -- Deterministic test clock returns synthetic Date values.
    now: () => new Date(1_700_000_000_000 + ++tick * 1_000),
  });
  opened.push(db);
  return db;
}

afterEach(() => {
  while (opened.length > 0) {
    opened.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("research-library validation and URL deduplication", () => {
  it("normalizes valid http/https URLs and rejects credentials, custom ports, and non-http protocols", () => {
    expect(normalizeLibraryUrl("  https://Example.COM/papers/123?a=1  ")).toBe(
      "https://example.com/papers/123?a=1",
    );
    expect(normalizeLibraryUrl("http://example.com:80/test")).toBe("http://example.com/test");
    expect(normalizeLibraryUrl("https://example.com:443/test")).toBe("https://example.com/test");

    expect(() => normalizeLibraryUrl("javascript:alert(1)")).toThrow(LibraryValidationError);
    expect(() => normalizeLibraryUrl("file:///etc/passwd")).toThrow(LibraryValidationError);
    expect(() => normalizeLibraryUrl("https://user:pass@example.com/secret")).toThrow(
      LibraryValidationError,
    );
    expect(() => normalizeLibraryUrl("https://example.com:8443/custom")).toThrow(
      LibraryValidationError,
    );
    expect(() => normalizeLibraryUrl(`https://example.com/${"a".repeat(2050)}`)).toThrow(
      LibraryValidationError,
    );
  });

  it("enforces unique URLs and rejects oversized title/body and invalid UTF-8 bytes", () => {
    const db = createTestDb();
    const saved = db.saveEntry({
      kind: "web",
      title: "Transformer paper",
      url: "https://arxiv.org/abs/1706.03762",
      body: "Attention Is All You Need.",
      tags: ["ML", "ml", "Transformers"],
    });
    expect(saved.tags).toEqual(["ML", "Transformers"]);

    expect(() =>
      db.saveEntry({
        kind: "web",
        title: "Duplicate URL",
        url: "https://ARXIV.ORG/abs/1706.03762",
      }),
    ).toThrow(LibraryDuplicateUrlError);

    expect(() =>
      db.saveEntry({
        kind: "note",
        title: "x".repeat(LIBRARY_MAX_TITLE_CHARS + 1),
      }),
    ).toThrow(LibraryValidationError);

    expect(() =>
      db.saveEntry({
        kind: "note",
        title: "Huge body",
        body: "b".repeat(LIBRARY_MAX_BODY_CHARS + 1),
      }),
    ).toThrow(LibraryValidationError);

    expect(() => decodeUtf8TextBytes(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(
      LibraryValidationError,
    );
  });

  it("imports UTF-8 markdown and txt files and derives title from heading or filename", () => {
    const db = createTestDb();
    const md = db.importTextFile({
      fileName: "notes.md",
      content: "# Quantum Error Correction\n\nSurface codes protect logical qubits.",
      tags: ["physics"],
    });
    expect(md.kind).toBe("file");
    expect(md.title).toBe("Quantum Error Correction");

    const txt = db.importTextFile({
      fileName: "reading-list.txt",
      content: "Plain text reading notes.",
    });
    expect(txt.title).toBe("reading-list");

    expect(() =>
      db.importTextFile({
        fileName: "paper.pdf",
        content: "%PDF-1.7",
      }),
    ).toThrow(LibraryValidationError);
  });
});

describe("research-library search (FTS5 + CJK short-query fallback + rebuild)", () => {
  it("uses FTS5 for 3+ char queries, falls back to substring for 1-2 char CJK queries, and returns bounded summaries", () => {
    const db = createTestDb();
    const hugeBody = `${"prefix ".repeat(400)}量子纠缠与量子计算基础概念。${" suffix".repeat(400)}`;
    const quantum = db.saveEntry({
      kind: "note",
      title: "量子计算导论",
      body: hugeBody,
      note: "重点关注容错阈值",
      tags: ["物理", "Quantum"],
      pageCount: 12,
      pages: [
        { physicalPage: 1, text: "Introduction to quantum circuits.", extractionStatus: "ok" },
        { physicalPage: 7, text: "本章讨论量子纠错码与表面码。", extractionStatus: "ok" },
      ],
    });
    db.saveEntry({
      kind: "web",
      title: "Attention Mechanism Survey",
      url: "https://example.org/attention",
      body: "Self-attention enables parallel sequence modeling.",
      tags: ["AI"],
    });

    const shortCjk = db.listEntries({ query: "量子" });
    expect(shortCjk.searchMode).toBe("substring");
    expect(shortCjk.total).toBe(1);
    expect(shortCjk.items[0]?.id).toBe(quantum.id);
    expect(shortCjk.items[0]?.matchedPages).toEqual([7]);
    expect(shortCjk.items[0]?.pageCount).toBe(12);
    expect(shortCjk.items[0]?.snippet.length).toBeLessThanOrEqual(LIBRARY_SNIPPET_MAX_CHARS);
    expect("body" in (shortCjk.items[0] ?? {})).toBe(false);

    const singleCharCjk = db.listEntries({ query: "量" });
    expect(singleCharCjk.searchMode).toBe("substring");
    expect(singleCharCjk.items.map((item) => item.id)).toEqual([quantum.id]);

    const ftsEnglish = db.listEntries({ query: "Self-attention" });
    expect(ftsEnglish.searchMode).toBe(db.ftsEnabled ? "fts5" : "substring");
    expect(ftsEnglish.total).toBe(1);
    expect(ftsEnglish.items[0]?.title).toBe("Attention Mechanism Survey");

    const ftsPage = db.listEntries({ query: "circuits" });
    expect(ftsPage.items.map((item) => item.id)).toEqual([quantum.id]);
    expect(ftsPage.items[0]?.matchedPages).toEqual([1]);

    const tagFiltered = db.listEntries({ tag: "quantum" });
    expect(tagFiltered.items.map((item) => item.id)).toEqual([quantum.id]);

    db.rebuildSearchIndex();
    const afterRebuild = db.listEntries({ query: "parallel" });
    expect(afterRebuild.total).toBe(1);
  });

  it("falls back cleanly to substring search when FTS5 is unavailable", () => {
    const db = createTestDb({ forceDisableFts: true });
    expect(db.ftsEnabled).toBe(false);
    const saved = db.saveEntry({
      kind: "note",
      title: "Fallback test",
      body: "Testing substring fallback for distributed consensus.",
    });
    const result = db.listEntries({ query: "consensus" });
    expect(result.searchMode).toBe("substring");
    expect(result.items.map((item) => item.id)).toEqual([saved.id]);
  });
});

describe("research-library optimistic locking and cascade deletion", () => {
  it("detects concurrent update and delete conflicts with currentRevision", () => {
    const db = createTestDb();
    const created = db.saveEntry({
      kind: "note",
      title: "Draft note",
      note: "v1",
    });
    expect(created.revision).toBe(1);

    const updated = db.updateEntry({
      id: created.id,
      expectedRevision: 1,
      note: "v2",
    });
    expect(updated.revision).toBe(2);

    try {
      db.updateEntry({
        id: created.id,
        expectedRevision: 1,
        note: "stale overwrite",
      });
      expect.unreachable("expected conflict error");
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryEditConflictError);
      if (error instanceof LibraryEditConflictError) {
        expect(error.expectedRevision).toBe(1);
        expect(error.currentRevision).toBe(2);
      }
    }

    try {
      db.deleteEntry({ id: created.id, expectedRevision: 1 });
      expect.unreachable("expected delete conflict error");
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryEditConflictError);
      if (error instanceof LibraryEditConflictError) {
        expect(error.currentRevision).toBe(2);
      }
    }

    const deleted = db.deleteEntry({ id: created.id, expectedRevision: 2 });
    expect(deleted).toEqual({ id: created.id, deletedRevision: 2 });
    expect(db.getEntry(created.id)).toBeNull();
    expect(() => db.deleteEntry({ id: created.id, expectedRevision: 2 })).toThrow(
      LibraryNotFoundError,
    );
  });

  it("cascades entry_pages deletion and leaves FTS5 consistent", () => {
    const db = createTestDb({ fileBacked: true });
    const entry = db.saveEntry({
      kind: "pdf",
      title: "Cascading Paper",
      pageCount: 5,
      pages: [
        { physicalPage: 1, text: "UniqueCascadeTokenAlpha", extractionStatus: "ok" },
        { physicalPage: 2, text: "UniqueCascadeTokenBeta", extractionStatus: "empty_scan" },
      ],
    });
    expect(db.getEntryPages(entry.id)).toHaveLength(2);
    expect(db.listEntries({ query: "UniqueCascadeTokenAlpha" }).total).toBe(1);

    db.deleteEntry({ id: entry.id, expectedRevision: entry.revision });
    expect(db.getEntryPages(entry.id)).toEqual([]);
    expect(db.listEntries({ query: "UniqueCascadeTokenAlpha" }).total).toBe(0);

    // Also verify foreign key ON DELETE CASCADE at the SQLite schema level directly.
    const entry2 = db.saveEntry({
      kind: "pdf",
      title: "Direct Cascade Paper",
      pageCount: 1,
      pages: [{ physicalPage: 1, text: "DirectCascadeToken", extractionStatus: "ok" }],
    });
    const rawPath = db.dbPath;
    db.close();
    const raw = new NodeSqlite.DatabaseSync(rawPath);
    raw.exec("PRAGMA foreign_keys = ON;");
    raw.prepare("DELETE FROM entries WHERE id = ?").run(entry2.id);
    const remaining = raw
      .prepare("SELECT COUNT(*) AS count FROM entry_pages WHERE entry_id = ?")
      .get(entry2.id) as { readonly count: number };
    expect(remaining.count).toBe(0);
    raw.close();
  });
});

describe("research-library bounded evidence draft composition", () => {
  it("composes bounded drafts with environmentId, entryId, revision, physical pages, and untrusted-data framing", () => {
    const db = createTestDb();
    const e1 = db.saveEntry({
      kind: "pdf",
      title: "Sparse Attention",
      url: "https://example.org/sparse",
      body: "Fallback body",
      note: "Compare complexity against standard softmax.",
      tags: ["LLM"],
      pageCount: 10,
      pages: [
        { physicalPage: 1, text: "Background on sequence models.", extractionStatus: "ok" },
        {
          physicalPage: 4,
          text: "Sparse attention reduces quadratic memory cost using block patterns.",
          extractionStatus: "ok",
        },
      ],
    });
    const e2 = db.saveEntry({
      kind: "note",
      title: "Synthetic benchmark",
      body: "Memory usage dropped 42% with block sparse attention.\n\nUnrelated paragraph ".repeat(
        200,
      ),
      note: "Run on synthetic fixture.",
    });

    const draft = db.composeDraft({
      environmentId: "env-a",
      entryIds: [e1.id, e2.id],
      question: "How does block sparse attention reduce memory cost?",
      maxTotalChars: 2_500,
    });

    expect(draft.includedEntryIds).toEqual([e1.id, e2.id]);
    expect(draft.prompt.length).toBeLessThanOrEqual(2_500);
    expect(draft.prompt).toContain("environmentId: env-a");
    expect(draft.prompt).toContain(`entryId: ${e1.id}`);
    expect(draft.prompt).toContain(`revision: ${e1.revision}`);
    expect(draft.prompt).toContain("p.4");
    expect(draft.prompt).toContain("untrusted reference data");
    expect(draft.truncated).toBe(true);

    // Reject more than 5 entries.
    expect(() =>
      composeLibraryDraft({
        environmentId: "env-a",
        question: "Too many",
        entries: Array.from({ length: 6 }, (_, i) => ({
          id: `id-${i}`,
          kind: "note",
          title: `Note ${i}`,
          url: null,
          body: "hello",
          note: "",
          tags: [],
          pageCount: 0,
          revision: 1,
        })),
      }),
    ).toThrow(LibraryValidationError);

    expect(LIBRARY_MAX_DRAFT_CHARS).toBe(24_000);
  });
});

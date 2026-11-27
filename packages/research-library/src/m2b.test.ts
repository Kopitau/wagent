// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Unit tests for pure non-Effect research-library storage and ima client.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  LibraryEditConflictError,
  LibrarySsrfRejectedError,
  LibraryValidationError,
} from "./errors.ts";
import { openLibraryDatabase, searchImaKnowledgeBase } from "./server/index.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "research-library-m2b-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("library.sqlite v3 reading persistence, cascade delete, idempotent MCP append, and ima client", () => {
  it("persists reading positions, paragraph annotations, questions, insights, preferences and cascades on entry delete", async () => {
    const dir = await makeTempDir();
    const db = openLibraryDatabase({
      dbPath: NodePath.join(dir, "library.sqlite"),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const entry = db.saveEntry({
      kind: "pdf",
      title: "Diffusion Policy",
      body: "Visuomotor policy learning via action diffusion.",
      note: "Initial note.",
      tags: ["robotics"],
      pageCount: 12,
      pages: [
        { physicalPage: 1, text: "Page 1 abstract text.", extractionStatus: "ok" },
        { physicalPage: 2, text: "Page 2 method text.", extractionStatus: "ok" },
      ],
    });

    expect(db.setReadingPosition(entry.id, 4)).toBe(4);
    const para = db.upsertReadingParagraph({
      entryId: entry.id,
      physicalPage: 2,
      anchor: "a1_deadbeef",
      quote: "Closed-loop action chunking stabilizes control.",
      note: "Check ablation in Table 2.",
      marked: true,
      highlighted: true,
      highlightColor: "yellow",
      wkbKind: "存疑",
      analysisJson: JSON.stringify({
        role: "method",
        importance: 5,
        summary: "Action chunking avoids compounding error.",
      }),
    });
    expect(para.marked).toBe(true);
    expect(para.wkbKind).toBe("存疑");

    const q = db.upsertReadingQuestion({
      entryId: entry.id,
      physicalPage: 2,
      anchor: "a1_deadbeef",
      question: "Why predict action horizons?",
      selfAnswer: "To keep temporally consistent trajectories.",
      answer: "Action chunking captures multi-modal distributions.",
      sourcesJson: JSON.stringify([{ physicalPage: 2, quote: "action chunking" }]),
      modelId: "api/deepseek-chat",
    });
    expect(q.selfAnswer).toContain("consistent");

    db.upsertReadingInsight({
      entryId: entry.id,
      kind: "guide",
      payloadJson: JSON.stringify({ position: { claim: "Diffusion handles multimodal actions." } }),
      modelId: "api/deepseek-chat",
    });
    db.setReadingPreference("global", JSON.stringify({ railLayout: "split", cardFontSize: 13 }));

    const state = db.getReadingState(entry.id);
    expect(state.physicalPage).toBe(4);
    expect(state.paragraphs).toHaveLength(1);
    expect(state.questions).toHaveLength(1);
    expect(state.insights).toHaveLength(1);
    expect(state.preferences.global).toContain("split");

    // Bounded MCP reading notes lookup
    const mcpNotes = db.getReadingNotesForMcp({ id: entry.id, maxChars: 2_000 });
    expect(mcpNotes.items).toHaveLength(1);
    expect(mcpNotes.items[0]?.cardSummary).toContain("Action chunking");
    expect(mcpNotes.items[0]?.wkbKind).toBe("存疑");

    // Idempotent append note
    const firstAppend = db.appendNoteIdempotent({
      entryId: entry.id,
      text: "Follow-up from agent review.",
      idempotencyKey: "idem-note-1",
    });
    expect(firstAppend.deduplicated).toBe(false);
    expect(firstAppend.entry.revision).toBe(2);
    expect(firstAppend.entry.note).toContain("Follow-up from agent review.");

    const replayAppend = db.appendNoteIdempotent({
      entryId: entry.id,
      text: "Follow-up from agent review.",
      idempotencyKey: "idem-note-1",
    });
    expect(replayAppend.deduplicated).toBe(true);
    expect(replayAppend.entry.revision).toBe(2);

    // Wrong expectedRevision rejects cleanly
    expect(() =>
      db.appendNoteIdempotent({
        entryId: entry.id,
        text: "Conflict",
        idempotencyKey: "idem-note-2",
        expectedRevision: 1,
      }),
    ).toThrowError(LibraryEditConflictError);

    // Cascade delete cleans up reading tables via foreign keys
    db.deleteEntry({ id: entry.id, expectedRevision: 2 });
    expect(db.getEntry(entry.id)).toBeNull();

    db.close();
  });

  it("validates ima HTTPS endpoints, rejects private hosts, and parses results", async () => {
    await expect(
      searchImaKnowledgeBase({
        baseUrl: "http://ima.example.com/api",
        apiKey: "secret",
        knowledgeBaseId: "kb-1",
        query: "diffusion",
      }),
    ).rejects.toThrowError(LibrarySsrfRejectedError);

    await expect(
      searchImaKnowledgeBase({
        baseUrl: "https://127.0.0.1/api",
        apiKey: "secret",
        knowledgeBaseId: "kb-1",
        query: "diffusion",
      }),
    ).rejects.toThrowError(LibrarySsrfRejectedError);

    await expect(
      searchImaKnowledgeBase({
        baseUrl: "https://ima.example.com/api",
        apiKey: "",
        knowledgeBaseId: "kb-1",
        query: "diffusion",
      }),
    ).rejects.toThrowError(LibraryValidationError);

    let capturedAuth = "";
    const hits = await searchImaKnowledgeBase({
      baseUrl: "https://ima.example.com/v1",
      apiKey: "ima-token-xyz",
      knowledgeBaseId: "kb-research",
      query: "diffusion",
      fetchImpl: async (_url, init) => {
        capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? "";
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "doc-1",
                title: "Diffusion Models Beat GANs",
                snippet: "Classifier guidance improves FID.",
                url: "https://arxiv.org/abs/2105.05233",
                score: 0.94,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(capturedAuth).toBe("Bearer ima-token-xyz");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe("Diffusion Models Beat GANs");
  });
});

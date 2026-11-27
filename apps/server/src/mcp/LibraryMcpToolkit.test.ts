import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LibraryService from "../library/LibraryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

/** Verifies M1b read-only Library MCP tools across direct, deferred, read-only, and no-MCP flows. */
it.effect(
  "verifies Library MCP capability matrix across direct, deferred, read-only, and no-MCP flows",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-mcp-matrix-" });
        const envId = EnvironmentId.make("env-library-mcp");

        const libraryLayer = LibraryService.layer.pipe(
          Layer.provide(ServerConfig.layerTest(tempDir, tempDir)),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(envId),
            }),
          ),
        );

        const builtLibrary = yield* Layer.build(libraryLayer);
        const library = builtLibrary.mapUnsafe.get(
          LibraryService.LibraryService.key,
        ) as LibraryService.LibraryService["Service"];

        const seeded = yield* library.save({
          kind: "pdf",
          title: "Quantum Error Correction",
          body: "[p.1]\nQuantum surface code overview.\n\n[p.2]\n量子纠错阈值实验结果。",
          note: "Key paper for architecture review.",
          tags: ["quantum", "paper"],
        });

        const directScope: McpInvocationContext.McpThreadInvocationScope = {
          environmentId: envId,
          requestNamespace: "directToken",
          thread: {
            threadId: ThreadId.make("thread-direct"),
            providerSessionId: "directToken",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const deferredScope: McpInvocationContext.McpThreadInvocationScope = {
          environmentId: envId,
          requestNamespace: "deferredToken",
          thread: {
            threadId: ThreadId.make("thread-deferred"),
            providerSessionId: "deferredToken",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const readOnlyClientScope: McpInvocationContext.McpInvocationScope = {
          environmentId: envId,
          requestNamespace: "readonlyClientToken",
          thread: undefined,
          client: {
            sessionId: "client-ro",
            label: "Read-Only External Client",
            access: "read-only",
          },
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const threadScopes = new Map<string, McpInvocationContext.McpThreadInvocationScope>([
          ["directToken", directScope],
          ["deferredToken", deferredScope],
        ]);

        const serverLayer = McpHttpServer.layerMcpTransport(
          Layer.mergeAll(McpHttpServer.layerLibraryToolkit, McpHttpServer.layerToolSearch),
        ).pipe(
          Layer.provide(Layer.succeed(LibraryService.LibraryService, library)),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: (request) =>
                Effect.succeed(
                  request.headers.authorization === "Bearer readonlyClientToken"
                    ? readOnlyClientScope
                    : undefined,
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) => Effect.succeed(threadScopes.get(token)),
            }),
          ),
        );

        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );

        const httpClient = yield* HttpClient.HttpClient;
        const openSession = (token: string, deferred: boolean) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
              ...(deferred ? { "t3-tool-exposure": "deferred" } : {}),
            };
            const init = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"matrix-probe","version":"1.0.0"}}}`,
                "application/json",
              ),
            });
            const rpc = (method: string, params: object) =>
              httpClient
                .post("/mcp", {
                  headers: {
                    ...headers,
                    "mcp-session-id": init.headers["mcp-session-id"]!,
                    "mcp-protocol-version": "2025-06-18",
                  },
                  body: HttpBody.text(
                    JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
                    "application/json",
                  ),
                })
                .pipe(
                  Effect.flatMap((res) => res.text),
                  Effect.map((text): unknown =>
                    text
                      .split("\n")
                      .filter((line) => line.startsWith("data: ") || line.startsWith("{"))
                      .map((line) => JSON.parse(line.replace(/^data: /u, "")) as { id?: number })
                      .find((message) => message.id === 2),
                  ),
                );
            return {
              listed: rpc("tools/list", {}).pipe(
                Effect.map((body) =>
                  (body as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools
                    .map((tool) => tool.name)
                    .sort(),
                ),
              ),
              call: (name: string, args: object) =>
                rpc("tools/call", { name, arguments: args }).pipe(
                  Effect.map(
                    (body) =>
                      (body as { result: { isError?: boolean; structuredContent?: unknown } })
                        .result,
                  ),
                ),
            };
          });

        // Seed a DeepRead paragraph note & muddiest point so library_get_reading_notes returns rich data
        yield* library.upsertReadingParagraph({
          entryId: seeded.id,
          physicalPage: 2,
          anchor: "fnv1a-p2-001",
          quote: "量子纠错阈值实验结果。",
          note: "需要核对表面码容错阈值数据。",
          marked: true,
          wkbKind: "存疑",
        });
        yield* library.upsertReadingQuestion({
          entryId: seeded.id,
          physicalPage: 2,
          anchor: "fnv1a-p2-001",
          question: "如何验证实验中的逻辑错误率？",
          selfAnswer: "核对不同码距下逻辑错误率曲线。",
          answer: "论文第 2 页给出了不同码距下的逻辑错误率曲线。",
        });

        // 1. Direct session sees all 7 library tools up front
        const direct = yield* openSession("directToken", false);
        expect(yield* direct.listed).toEqual([
          "library_append_note",
          "library_get_reading_notes",
          "library_read_item",
          "library_run_feed",
          "library_save_url",
          "library_search",
          "library_work_harvest",
        ]);

        const searchResult = yield* direct.call("library_search", { query: "量子" });
        expect(searchResult.isError).not.toBe(true);
        expect(searchResult.structuredContent).toMatchObject({
          total: 1,
          items: [{ id: seeded.id, title: "Quantum Error Correction" }],
        });

        const readResult = yield* direct.call("library_read_item", {
          id: seeded.id,
          maxChars: 1000,
        });
        expect(readResult.isError).not.toBe(true);
        expect(readResult.structuredContent).toMatchObject({
          id: seeded.id,
          note: "Key paper for architecture review.",
          blobMissing: false,
        });
        expect(
          (readResult.structuredContent as { untrustedContentNotice: string })
            .untrustedContentNotice,
        ).toContain("UNTRUSTED EXTERNAL REFERENCE DATA");

        // 1b. library_get_reading_notes exposes structured paragraphs + untrusted notice
        const notesResult = yield* direct.call("library_get_reading_notes", {
          id: seeded.id,
          includeCards: true,
        });
        expect(notesResult.isError).not.toBe(true);
        expect(notesResult.structuredContent).toMatchObject({
          entryId: seeded.id,
          totalItems: 1,
          items: [
            {
              physicalPage: 2,
              anchor: "fnv1a-p2-001",
              wkbKind: "存疑",
              marked: true,
            },
          ],
        });
        expect(
          (notesResult.structuredContent as { untrustedContentNotice: string })
            .untrustedContentNotice,
        ).toContain("UNTRUSTED EXTERNAL REFERENCE DATA");

        // 1c. library_append_note is idempotent under repeated idempotencyKey
        const append1 = yield* direct.call("library_append_note", {
          id: seeded.id,
          text: "Verified logical error rate scaling.",
          idempotencyKey: "idem-append-001",
        });
        expect(append1).toMatchObject({
          structuredContent: {
            entryId: seeded.id,
            deduplicated: false,
          },
        });
        expect(append1.isError).not.toBe(true);
        const revAfterAppend1 = (append1.structuredContent as { revision: number }).revision;

        const append2 = yield* direct.call("library_append_note", {
          id: seeded.id,
          text: "Verified logical error rate scaling.",
          idempotencyKey: "idem-append-001",
        });
        expect(append2.isError).not.toBe(true);
        expect(append2.structuredContent).toMatchObject({
          entryId: seeded.id,
          revision: revAfterAppend1,
          deduplicated: true,
        });
        const reloadedAfterAppend = yield* library.get({ id: seeded.id });
        expect(
          reloadedAfterAppend.entry.note.match(/Verified logical error rate scaling\./g),
        ).toHaveLength(1);

        // 1d. library_save_url rejects private-network SSRF targets
        const ssrfSave = yield* direct.call("library_save_url", {
          url: "http://127.0.0.1:8080/internal",
        });
        expect(ssrfSave.isError).toBe(true);

        // 1e. library_run_feed respects paused feeds immediately without outbound fetch
        const pausedFeed = yield* library.upsertFeed({
          name: "Paused arXiv Feed",
          kind: "arxiv",
          url: "https://export.arxiv.org/api/query?search_query=cat:cs.AI",
          enabled: false,
        });
        const pausedRun = yield* direct.call("library_run_feed", { feedId: pausedFeed.id });
        expect(pausedRun.isError).not.toBe(true);
        expect(pausedRun.structuredContent).toMatchObject({
          feedId: pausedFeed.id,
          skippedPaused: true,
          importedCount: 0,
        });

        // 2. Deferred session initially only sees tool_search, discovers library tools via tool_search
        const deferred = yield* openSession("deferredToken", true);
        expect(yield* deferred.listed).toEqual(["tool_search"]);
        const discovered = yield* deferred.call("tool_search", { query: "research library pdf" });
        expect(discovered.isError).not.toBe(true);
        const listedAfterDiscover = yield* deferred.listed;
        expect(listedAfterDiscover).toContain("library_read_item");
        expect(listedAfterDiscover).toContain("library_search");
        expect(listedAfterDiscover).toContain("tool_search");
        const deferredRead = yield* deferred.call("library_read_item", { id: seeded.id });
        expect(deferredRead.isError).not.toBe(true);

        // 3. Read-only external MCP client can read library & reading notes, but is STRICTLY REFUSED on writes
        const readOnlyClient = yield* openSession("readonlyClientToken", false);
        expect(yield* readOnlyClient.listed).toEqual([
          "library_append_note",
          "library_get_reading_notes",
          "library_read_item",
          "library_run_feed",
          "library_save_url",
          "library_search",
          "library_work_harvest",
        ]);
        const roSearch = yield* readOnlyClient.call("library_search", { tag: "quantum" });
        expect(roSearch.isError).not.toBe(true);
        const roNotes = yield* readOnlyClient.call("library_get_reading_notes", { id: seeded.id });
        expect(roNotes.isError).not.toBe(true);
        const roAppendBlocked = yield* readOnlyClient.call("library_append_note", {
          id: seeded.id,
          text: "Should be denied",
          idempotencyKey: "ro-denied-1",
        });
        expect(roAppendBlocked.isError).toBe(true);
        expect(JSON.stringify(roAppendBlocked)).toContain("capability_denied");
        const roSaveUrlBlocked = yield* readOnlyClient.call("library_save_url", {
          url: "https://example.com/paper",
        });
        expect(roSaveUrlBlocked.isError).toBe(true);
        expect(JSON.stringify(roSaveUrlBlocked)).toContain("capability_denied");
        const roRunFeedBlocked = yield* readOnlyClient.call("library_run_feed", {
          feedId: pausedFeed.id,
        });
        expect(roRunFeedBlocked.isError).toBe(true);
        expect(JSON.stringify(roRunFeedBlocked)).toContain("capability_denied");
        const roWorkHarvestBlocked = yield* readOnlyClient.call("library_work_harvest", {
          project: "wagent",
        });
        expect(roWorkHarvestBlocked.isError).toBe(true);
        expect(JSON.stringify(roWorkHarvestBlocked)).toContain("capability_denied");
        // Confirm database was untouched by refused read-only write attempt
        const afterRoAttempt = yield* library.get({ id: seeded.id });
        expect(afterRoAttempt.entry.note).not.toContain("Should be denied");

        // 4. No-MCP fallback: self-contained draft still carries full reviewed excerpts
        const draft = yield* library.composeDraft({
          entryIds: [seeded.id],
          question: "Summarize the surface code threshold.",
        });
        expect(draft.prompt).toContain(envId);
        expect(draft.prompt).toContain(seeded.id);
        expect(draft.prompt).toContain("Quantum surface code overview.");
        expect(draft.prompt).toContain("Key paper for architecture review.");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
);

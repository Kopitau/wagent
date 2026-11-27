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
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
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

        // 1. Direct session sees both library tools up front and searches CJK + reads entry with untrusted notice
        const direct = yield* openSession("directToken", false);
        expect(yield* direct.listed).toEqual(["library_read_item", "library_search"]);

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

        // 2. Deferred session initially only sees tool_search, discovers library tools via tool_search
        const deferred = yield* openSession("deferredToken", true);
        expect(yield* deferred.listed).toEqual(["tool_search"]);
        const discovered = yield* deferred.call("tool_search", { query: "research library pdf" });
        expect(discovered.isError).not.toBe(true);
        expect(yield* deferred.listed).toEqual([
          "library_read_item",
          "library_search",
          "tool_search",
        ]);
        const deferredRead = yield* deferred.call("library_read_item", { id: seeded.id });
        expect(deferredRead.isError).not.toBe(true);

        // 3. Read-only external MCP client can read library via read-only tools
        const readOnlyClient = yield* openSession("readonlyClientToken", false);
        expect(yield* readOnlyClient.listed).toEqual(["library_read_item", "library_search"]);
        const roSearch = yield* readOnlyClient.call("library_search", { tag: "quantum" });
        expect(roSearch.isError).not.toBe(true);

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

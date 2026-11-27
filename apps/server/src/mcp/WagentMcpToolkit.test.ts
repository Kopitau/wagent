import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { WagentExecutor } from "@t3tools/wagent-bridge";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LibraryService from "../library/LibraryService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WagentService from "../wagent/WagentService.ts";
import * as WkbBridgeService from "../wkb/WkbBridgeService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

it.effect(
  "enforces McpToolAccess.writes on wagent_dispatch/cancel/convert while allowing read-only wagent_status",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wagent-mcp-" });
        const homeDir = path.join(tempDir, "home");
        const exportsDir = path.join(homeDir, "Wagent", "exports");
        yield* fs.makeDirectory(exportsDir, { recursive: true });
        const fixtureMdPath = path.join(exportsDir, "mcp-export.md");
        yield* fs.writeFileString(fixtureMdPath, "# MCP Export\n\nBody.");
        const envId = EnvironmentId.make("env-wagent-mcp");

        const executor: WagentExecutor = {
          async run(input) {
            input.callbacks.onText(`mcp-executed:${input.prompt}`);
          },
        };

        const baseConfigLayer = ServerConfig.layerTest(tempDir, tempDir);
        const secretStoreLayer = ServerSecretStore.layer.pipe(Layer.provide(baseConfigLayer));
        const wkbLayer = WkbBridgeService.layer.pipe(Layer.provide(baseConfigLayer));
        const libraryLayer = LibraryService.layer.pipe(
          Layer.provide(baseConfigLayer),
          Layer.provide(wkbLayer),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(envId),
            }),
          ),
        );
        const wagentLayer = WagentService.makeLayer({
          executor,
          wkbExportImpl: async (input) => ({
            title: "MCP Export",
            markdownPath: fixtureMdPath,
            markdown: "# MCP Export\n\nBody.",
            pdfPath: null,
            warnings: [],
            inferredKind: "web",
            sourceUrl: input.source,
          }),
        }).pipe(
          Layer.provide(baseConfigLayer),
          Layer.provide(secretStoreLayer),
          Layer.provide(libraryLayer),
          Layer.provide(wkbLayer),
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, homeDir)),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, tempDir)),
        );

        const builtWagent = yield* Layer.build(wagentLayer);
        const wagent = builtWagent.mapUnsafe.get(
          WagentService.WagentService.key,
        ) as WagentService.WagentService["Service"];

        const fullAccessClientScope: McpInvocationContext.McpInvocationScope = {
          environmentId: envId,
          requestNamespace: "fullClientToken",
          thread: undefined,
          client: {
            sessionId: "client-full",
            label: "Full-Access Orchestrator Client",
            access: "full-access",
          },
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
        const deferredThreadScope: McpInvocationContext.McpThreadInvocationScope = {
          environmentId: envId,
          requestNamespace: "deferredThreadToken",
          thread: {
            threadId: ThreadId.make("thread-deferred-wagent"),
            providerSessionId: "deferredThreadToken",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        const serverLayer = McpHttpServer.layerMcpTransport(
          Layer.mergeAll(McpHttpServer.layerWagentToolkit, McpHttpServer.layerToolSearch),
        ).pipe(
          Layer.provide(Layer.succeed(WagentService.WagentService, wagent)),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provide(
            Layer.succeed(McpHttpServer.McpClientAuthenticator, {
              authenticate: (request) => {
                if (request.headers.authorization === "Bearer fullClientToken") {
                  return Effect.succeed(fullAccessClientScope);
                }
                if (request.headers.authorization === "Bearer readonlyClientToken") {
                  return Effect.succeed(readOnlyClientScope);
                }
                return Effect.undefined;
              },
            }),
          ),
          Layer.provide(
            Layer.mock(McpSessionRegistry.McpSessionRegistry)({
              resolve: (token) =>
                Effect.succeed(token === "deferredThreadToken" ? deferredThreadScope : undefined),
            }),
          ),
        );

        yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );

        const httpClient = yield* HttpClient.HttpClient;
        const openSession = (token: string, deferred = false) =>
          Effect.gen(function* () {
            const headers = {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
              ...(deferred ? { "t3-tool-exposure": "deferred" } : {}),
            };
            const init = yield* httpClient.post("/mcp", {
              headers,
              body: HttpBody.text(
                `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"wagent-mcp-test","version":"1.0.0"}}}`,
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
              call: (name: string, args: Record<string, unknown>) =>
                rpc("tools/call", { name, arguments: args }).pipe(
                  Effect.map((body) => {
                    const result = (
                      body as {
                        result: {
                          isError?: boolean;
                          content: ReadonlyArray<{ text?: string }>;
                        };
                      }
                    ).result;
                    const text = result.content[0]?.text ?? "";
                    return {
                      isError: Boolean(result.isError),
                      text,
                      parsed: text.startsWith("{")
                        ? (JSON.parse(text) as Record<string, unknown>)
                        : null,
                    };
                  }),
                ),
            };
          });

        // 1. Read-only MCP client can inspect status, but is refused on all write tools
        const readOnly = yield* openSession("readonlyClientToken");
        const statusCall = yield* readOnly.call("wagent_status", {});
        expect(statusCall.isError).toBe(false);
        expect(statusCall.parsed?.running).toBe(false);

        const refusedDispatch = yield* readOnly.call("wagent_dispatch", {
          prompt: "should be refused",
        });
        expect(refusedDispatch.isError).toBe(true);
        expect(refusedDispatch.text).toMatch(/read-only|capability_denied/i);

        const refusedCancel = yield* readOnly.call("wagent_cancel", {});
        expect(refusedCancel.isError).toBe(true);

        const refusedConvert = yield* readOnly.call("wagent_convert_to_doc", {
          source: "https://example.com/blocked",
        });
        expect(refusedConvert.isError).toBe(true);

        // 2. Full-access MCP client can dispatch, convert, and inspect completed result
        const full = yield* openSession("fullClientToken");
        const dispatched = yield* full.call("wagent_dispatch", {
          prompt: "summarize daily inbox",
          awaitCompletion: true,
        });
        expect(dispatched.isError).toBe(false);
        const run = dispatched.parsed?.run as { status: string; source: string; output: string };
        expect(run.status).toBe("completed");
        expect(run.source).toBe("mcp");
        expect(run.output).toBe("mcp-executed:summarize daily inbox");

        const converted = yield* full.call("wagent_convert_to_doc", {
          source: "https://example.com/doc",
        });
        expect(converted.isError).toBe(false);
        expect(converted.parsed?.title).toBe("MCP Export");

        // 3. Deferred tool_search discovers Wagent tools
        const deferred = yield* openSession("deferredThreadToken", true);
        const search = yield* deferred.call("tool_search", { query: "wagent" });
        expect(search.isError).toBe(false);
        expect(search.text).toContain("wagent_dispatch");
        expect(search.text).toContain("wagent_status");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NodeHttpServer.layerTest),
      ),
    ),
);

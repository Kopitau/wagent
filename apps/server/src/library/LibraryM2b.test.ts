import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretReferencePath,
  type ServerProvider,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as WkbBridgeService from "../wkb/WkbBridgeService.ts";
import * as LibraryService from "./LibraryService.ts";
import * as ReadingAiRunner from "./ReadingAiRunner.ts";

function makeInMemorySecretStore() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    layer: Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: (key) => Effect.succeed(Option.fromNullishOr(store.get(key))),
      set: (key, value) =>
        Effect.sync(() => {
          store.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          store.delete(key);
        }),
    }),
  };
}

describe("LibraryService M2b reading, AI dual-route, wkb sync, and ima credentials", () => {
  it.effect(
    "supports direct_api and cli_subscription (empty temp cwd) AI routes and persists nothing on cancel",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-m2b-ai-" });
          const envId = EnvironmentId.make("env-m2b-ai");

          let capturedCliCommand = "";
          let capturedCliArgs: ReadonlyArray<string> = [];
          let capturedCliCwd = "";
          let capturedCliCwdWasEmpty = false;
          let capturedCliCwdExisted = false;

          const directStarted = yield* Deferred.make<void>();
          const directBlock = yield* Deferred.make<void>();
          let blockNextDirectCall = false;

          const mockProcessRunner = Layer.mock(ProcessRunner.ProcessRunner)({
            run: (options) =>
              Effect.gen(function* () {
                capturedCliCommand = options.command;
                capturedCliArgs = options.args ?? [];
                capturedCliCwd = options.cwd ?? "";
                capturedCliCwdExisted = capturedCliCwd
                  ? yield* fs.exists(capturedCliCwd).pipe(Effect.orElseSucceed(() => false))
                  : false;
                if (capturedCliCwdExisted) {
                  const entries = yield* fs
                    .readDirectory(capturedCliCwd)
                    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
                  capturedCliCwdWasEmpty = entries.length === 0;
                }
                return {
                  stdout: JSON.stringify({
                    answer: "Surface code achieves threshold near 1%.",
                    sources: [{ physicalPage: 99, quote: "Surface code threshold." }],
                  }),
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  signal: null,
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          });

          const mockTextGenerators = Layer.mock(TextGenerators.TextGenerators)({
            listModels: () =>
              Effect.succeed({
                models: [{ id: "gpt-4o-mini", name: "GPT-4o Mini" }],
              }),
            runner: () =>
              Effect.succeed(((request: { readonly outputSchema: unknown }) =>
                Effect.gen(function* () {
                  if (blockNextDirectCall) {
                    yield* Deferred.succeed(directStarted, undefined);
                    yield* Deferred.await(directBlock);
                  }
                  void request;
                  return {
                    role: "contribution",
                    importance: 5,
                    summary: "提出表面码纠错阈值改进方法。",
                    points: ["核心贡献 1", "核心贡献 2"],
                    explanation: "通过改进解码器降低逻辑错误率。",
                    translation: "我们提出一种新的表面码解码方案。",
                    keySentence: "We propose a surface code decoder.",
                  } as never;
                })) as never),
          });

          const cliSnapshot: ServerProvider = {
            instanceId: ProviderInstanceId.make("claude-sub"),
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Claude Sub",
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "2026-11-24T00:00:00.000Z",
            models: [
              {
                slug: "claude-sonnet-4-5",
                name: "Claude Sonnet 4.5",
                isCustom: false,
                capabilities: null,
                supportsTextGeneration: true,
              },
            ],
            slashCommands: [],
            skills: [],
          };

          const mockRegistry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed([
              {
                snapshot: {
                  getSnapshot: Effect.succeed(cliSnapshot),
                },
              } as never,
            ]),
            getInstance: (id) =>
              Effect.succeed(
                id === cliSnapshot.instanceId
                  ? ({
                      snapshot: {
                        getSnapshot: Effect.succeed(cliSnapshot),
                      },
                    } as never)
                  : undefined,
              ),
          });

          const textGeneratorsConfig: Record<
            ProviderInstanceId,
            {
              readonly kind: "openaiCompatible";
              readonly label: string;
              readonly enabled: boolean;
              readonly apiKey: string;
              readonly baseUrl: string;
            }
          > = {
            [ProviderInstanceId.make("tg-direct")]: {
              kind: "openaiCompatible",
              label: "OpenAI Direct",
              enabled: true,
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
            },
          };
          const settingsLayer = ServerSettings.layerTest({
            textGenerators: textGeneratorsConfig,
          });

          const readingAiLayer = ReadingAiRunner.layer.pipe(
            Layer.provide(settingsLayer),
            Layer.provide(mockTextGenerators),
            Layer.provide(mockRegistry),
            Layer.provide(mockProcessRunner),
          );

          const libraryLayer = LibraryService.layer.pipe(
            Layer.provide(readingAiLayer),
            Layer.provide(ServerConfig.layerTest(tempDir, tempDir)),
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(envId),
              }),
            ),
          );

          const built = yield* Layer.build(libraryLayer);
          const library = built.mapUnsafe.get(
            LibraryService.LibraryService.key,
          ) as LibraryService.LibraryService["Service"];

          const entry = yield* library.save({
            kind: "pdf",
            title: "Surface Code Paper",
            body: "[p.1]\nWe propose a surface code decoder.\n\n[p.2]\nSurface code threshold results.",
            note: "",
            tags: ["quantum"],
          });

          // 1. Both direct_api and cli_subscription models are listed with distinct route badges
          const listedModels = yield* library.listReadingModels();
          expect(listedModels.models.some((m) => m.route === "direct_api")).toBe(true);
          expect(listedModels.models.some((m) => m.route === "cli_subscription")).toBe(true);

          // 2. direct_api route persists analyzed paragraph card
          const directRes = yield* library.runReadingAiAction({
            entryId: entry.id,
            action: "analyze_paragraph",
            physicalPage: 1,
            anchor: "fnv1a-p1-001",
            quote: "We propose a surface code decoder.",
            instanceId: "tg-direct",
            model: "gpt-4o-mini",
          });
          expect(directRes.route).toBe("direct_api");
          expect(directRes.paragraph?.anchor).toBe("fnv1a-p1-001");

          // 3. cli_subscription route executes inside a fresh EMPTY temp cwd with --tools "" and clamps page 99 -> 1..pageCount
          const cliRes = yield* library.runReadingAiAction({
            entryId: entry.id,
            action: "ask_question",
            physicalPage: 1,
            question: "What is the surface code threshold?",
            instanceId: "claude-sub",
            model: "claude-sonnet-4-5",
          });
          expect(cliRes.route).toBe("cli_subscription");
          expect(capturedCliCommand).toBe("claude");
          expect(capturedCliArgs).toContain("--tools");
          expect(capturedCliArgs).toContain("");
          expect(capturedCliArgs).toContain("--no-session-persistence");
          expect(capturedCliCwd).toContain("t3-library-reading-cli-");
          expect(capturedCliCwdExisted).toBe(true);
          expect(capturedCliCwdWasEmpty).toBe(true);
          // Temp cwd must be cleaned up after scoped execution finishes
          expect(yield* fs.exists(capturedCliCwd)).toBe(false);
          // Citation physicalPage 99 clamped to entry's max page (1 for text-seeded entry with pageCount=0 -> maxPage=1)
          const parsedAsk = JSON.parse(cliRes.payloadJson) as {
            sources: ReadonlyArray<{ physicalPage: number }>;
          };
          expect(parsedAsk.sources[0]?.physicalPage).toBe(1);

          // 4. Cancelling an in-flight AI action via fiber interruption writes ZERO dirty rows to SQLite
          blockNextDirectCall = true;
          const runningFiber = yield* Effect.forkChild(
            library.runReadingAiAction({
              entryId: entry.id,
              action: "analyze_paragraph",
              physicalPage: 1,
              anchor: "fnv1a-cancelled-anchor",
              quote: "Should never be persisted",
              instanceId: "tg-direct",
              model: "gpt-4o-mini",
            }),
          );
          yield* Deferred.await(directStarted);
          yield* Fiber.interrupt(runningFiber);

          const stateAfterCancel = yield* library.getReadingState({ entryId: entry.id });
          expect(
            stateAfterCancel.paragraphs.some((p) => p.anchor === "fnv1a-cancelled-anchor"),
          ).toBe(false);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "syncs all 6 wkb annotation kinds, submits to wkb, imports DeepRead Guide, and stores ima credentials safely",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-m2b-wkb-" });
          const envId = EnvironmentId.make("env-m2b-wkb");

          const syncedBatches: Array<ReadonlyArray<{ kind: string; text: string }>> = [];
          const submittedItems: Array<{ title: string; note?: string | undefined }> = [];

          const mockWkb = Layer.mock(WkbBridgeService.WkbBridgeService)({
            status: Effect.succeed({
              available: true,
              syncAvailable: true,
              mode: "local" as const,
              remoteUrl: null,
              uvPath: "uv",
              kbDir: tempDir,
            }),
            annotate: (input) =>
              Effect.sync(() => {
                syncedBatches.push(input.annotations.map((a) => ({ kind: a.kind, text: a.text })));
                return {
                  mode: "local" as const,
                  syncedCount: input.annotations.length,
                  summary: "ok",
                };
              }),
            submit: (input) =>
              Effect.sync(() => {
                submittedItems.push({ title: input.title, note: input.note });
                return {
                  mode: "local" as const,
                  summary: "ingested",
                };
              }),
          });

          const secrets = makeInMemorySecretStore();
          const mockSecretResolver = Layer.mock(SecretResolver.SecretResolver)({
            read: (refs) =>
              Effect.succeed(
                refs.map((ref) =>
                  ref.reference === "ima-prod-key" ? "resolved-secret-token" : undefined,
                ),
              ),
            label: (providerId) => Effect.succeed(String(providerId)),
          });

          const libraryLayer = LibraryService.layer.pipe(
            Layer.provide(mockWkb),
            Layer.provide(secrets.layer),
            Layer.provide(mockSecretResolver),
            Layer.provide(ServerConfig.layerTest(tempDir, tempDir)),
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(envId),
              }),
            ),
          );

          const built = yield* Layer.build(libraryLayer);
          const library = built.mapUnsafe.get(
            LibraryService.LibraryService.key,
          ) as LibraryService.LibraryService["Service"];

          const entry = yield* library.save({
            kind: "pdf",
            title: "Attention Is All You Need",
            body: "Self-attention replaces recurrence.",
            note: "Classic transformer architecture.",
            tags: ["transformer"],
          });

          // Import DeepRead v1.4.0 5-stage guide JSON
          const guideJson = JSON.stringify({
            schema_version: 1,
            paper: {
              title: "Attention Is All You Need",
              one_liner: "Pure self-attention architecture.",
            },
            reading_path: ["[p.1 ¶1]", "[p.3 ¶2]"],
            stages: {
              position: {
                core_question: "Can attention replace RNNs?",
                significance: "Parallel training.",
              },
              skeleton: [
                {
                  section: "Model Architecture",
                  role: "method",
                  summary: "Encoder-decoder",
                  anchor: "[p.3 ¶1]",
                },
              ],
              method: {
                core_idea: "Scaled dot-product",
                steps: ["QKV projection", "Softmax"],
                anchor: "[p.4 ¶1]",
              },
              evidence: [
                { claim: "28.4 BLEU on WMT14 EN-DE", metric: "28.4 BLEU", anchor: "[p.8 ¶1]" },
              ],
              takeaway: {
                strengths: ["Parallelizable"],
                limitations: ["Quadratic memory"],
                open_questions: ["Long context"],
              },
            },
          });
          const importedInsight = yield* library.importGuide({
            entryId: entry.id,
            content: guideJson,
          });
          expect(importedInsight.kind).toBe("guide");

          // Persist 6 annotations covering all 6 wkb kinds
          const kinds = ["重点", "存疑", "待办", "概念", "深挖", "问"] as const;
          for (const [idx, kind] of kinds.entries()) {
            yield* library.upsertReadingParagraph({
              entryId: entry.id,
              physicalPage: idx + 1,
              anchor: `anchor-${idx}`,
              quote: `Quote for ${kind}`,
              note: `Note for ${kind}`,
              marked: kind === "存疑",
              wkbKind: kind,
            });
          }

          const syncRes = yield* library.syncWkbAnnotations({
            entryId: entry.id,
            sourceId: "attention-paper",
          });
          expect(syncRes.syncedCount).toBe(6);
          expect(syncedBatches[0]?.map((item) => item.kind)).toEqual([...kinds]);

          const submitRes = yield* library.submitToWkb({
            entryId: entry.id,
            note: "Ready for brain vault.",
          });
          expect(submitRes.summary).toBe("ingested");
          expect(submittedItems[0]?.title).toBe("Attention Is All You Need");
          expect(submittedItems[0]?.note).toContain("Ready for brain vault.");

          // ima credential handling: raw secret stored ONLY in ServerSecretStore, never plaintext in ima.json
          const updated = yield* library.updateImaConfig({
            enabled: true,
            baseUrl: "https://ima.example.com/v1",
            knowledgeBaseId: "kb-main",
            apiKey: "super-secret-ima-token",
          });
          expect(updated).toEqual({
            enabled: true,
            baseUrl: "https://ima.example.com/v1",
            knowledgeBaseId: "kb-main",
            hasApiKey: true,
          });
          const rawConfigOnDisk = yield* fs.readFileString(
            path.join(tempDir, "userdata", "research-library", "ima.json"),
          );
          expect(rawConfigOnDisk).not.toContain("super-secret-ima-token");
          expect(secrets.store.has("library-ima-api-key")).toBe(true);

          // SecretReference mode clears local secret store entry and records only reference metadata
          const refUpdated = yield* library.updateImaConfig({
            apiKey: {
              provider: SecretProviderId.make("env"),
              reference: SecretReferencePath.make("ima-prod-key"),
            },
          });
          expect(refUpdated.hasApiKey).toBe(true);
          expect(secrets.store.has("library-ima-api-key")).toBe(false);
          const refConfigOnDisk = yield* fs.readFileString(
            path.join(tempDir, "userdata", "research-library", "ima.json"),
          );
          expect(refConfigOnDisk).toContain("ima-prod-key");
          expect(refConfigOnDisk).not.toContain("resolved-secret-token");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "fails closed when model catalog enumeration errors and binds WkbBridgeService remote tokens to exact query/path URLs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-library-strict-cat-" });
          const envId = EnvironmentId.make("env-strict-cat");

          let runnerCalls = 0;
          const brokenTextGenerators = Layer.mock(TextGenerators.TextGenerators)({
            listModels: () =>
              Effect.fail({
                _tag: "TextGenerationError",
                detail: "catalog unreachable",
                message: "catalog unreachable",
              } as never),
            runner: () =>
              Effect.succeed((() =>
                Effect.sync(() => {
                  runnerCalls += 1;
                  return {} as never;
                })) as never),
          });

          const mockRegistry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed([]),
            getInstance: () => Effect.undefined,
          });

          const settingsLayer = ServerSettings.layerTest({
            textGenerators: {
              [ProviderInstanceId.make("named")]: {
                kind: "openaiCompatible",
                label: "Named Provider",
                enabled: true,
                apiKey: "sk-test",
                baseUrl: "https://api.openai.com/v1",
              },
            },
          });

          const readingAiLayer = ReadingAiRunner.layer.pipe(
            Layer.provide(settingsLayer),
            Layer.provide(brokenTextGenerators),
            Layer.provide(mockRegistry),
          );

          const libraryLayer = LibraryService.layer.pipe(
            Layer.provide(readingAiLayer),
            Layer.provide(ServerConfig.layerTest(tempDir, tempDir)),
            Layer.provide(
              Layer.mock(ServerEnvironment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(envId),
              }),
            ),
          );

          const built = yield* Layer.build(libraryLayer);
          const library = built.mapUnsafe.get(
            LibraryService.LibraryService.key,
          ) as LibraryService.LibraryService["Service"];

          const entry = yield* library.save({
            kind: "pdf",
            title: "Strict Catalog Paper",
            body: "[p.1]\nBody text.",
          });

          const catalogErrRes = yield* library
            .runReadingAiAction({
              entryId: entry.id,
              action: "summary5",
              instanceId: "named",
              model: "explicit",
            })
            .pipe(Effect.result);
          expect(catalogErrRes._tag).toBe("Failure");
          expect(runnerCalls).toBe(0);

          // WkbBridgeService exact endpoint binding: ?tenant=fixture/ sent verbatim; /kb vs /kb/ rejected
          const secrets = makeInMemorySecretStore();
          secrets.store.set(
            "wagent-wkb-token",
            new TextEncoder().encode(
              JSON.stringify({
                token: "bound-tok",
                kbUrl: "https://kb.example.invalid/mcp?tenant=fixture/",
              }),
            ),
          );
          const seenRemoteUrls: string[] = [];
          const wkbCtx = yield* Layer.build(
            WkbBridgeService.makeLayer({
              fetchImpl: async (url, init) => {
                seenRemoteUrls.push(String(url));
                if (String(init?.method ?? "POST").toUpperCase() === "DELETE") {
                  return new Response(null, { status: 204 });
                }
                const req = JSON.parse(String(init?.body ?? "{}")) as {
                  id?: number;
                  method: string;
                };
                if (req.method === "notifications/initialized") {
                  return new Response(null, { status: 202 });
                }
                if (req.method === "initialize") {
                  return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }), {
                    status: 200,
                  });
                }
                if (req.method === "tools/list") {
                  return new Response(
                    JSON.stringify({
                      jsonrpc: "2.0",
                      id: req.id,
                      result: { tools: [{ name: "work_harvest" }] },
                    }),
                    { status: 200 },
                  );
                }
                return new Response(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: req.id,
                    result: { content: [{ text: "ok" }] },
                  }),
                  { status: 200 },
                );
              },
            }).pipe(
              Layer.provide(ServerConfig.layerTest(tempDir, tempDir)),
              Layer.provide(secrets.layer),
            ),
          );
          const wkbSvc = wkbCtx.mapUnsafe.get(
            WkbBridgeService.WkbBridgeService.key,
          ) as WkbBridgeService.WkbBridgeService["Service"];
          const whRes = yield* wkbSvc.workHarvest({ project: "demo" });
          expect(whRes.mode).toBe("remote");
          expect(seenRemoteUrls).toEqual([
            "https://kb.example.invalid/mcp?tenant=fixture/",
            "https://kb.example.invalid/mcp?tenant=fixture/",
            "https://kb.example.invalid/mcp?tenant=fixture/",
          ]);

          // Persisted config.json with '/kb/' must NOT match secret bound to '/kb'
          secrets.store.set(
            "wagent-wkb-token",
            new TextEncoder().encode(
              JSON.stringify({
                token: "bound-slashless",
                kbUrl: "https://kb.example.invalid/kb",
              }),
            ),
          );
          const wagentCfgDir = path.join(tempDir, "userdata", "wagent");
          yield* fs.makeDirectory(wagentCfgDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(wagentCfgDir, "config.json"),
            JSON.stringify({ kbUrl: "https://kb.example.invalid/kb/" }),
          );
          const mismatchStatus = yield* wkbSvc.status;
          expect(mismatchStatus.syncAvailable).toBe(false);
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

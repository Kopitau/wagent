import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { TelegramPort, WagentExecutor } from "@t3tools/wagent-bridge";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LibraryService from "../library/LibraryService.ts";
import * as WkbBridgeService from "../wkb/WkbBridgeService.ts";
import * as WagentService from "./WagentService.ts";

function buildMinimalValidPdf(text: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [4 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(`BT /F1 16 Tf 40 700 Td (${text}) Tj ET`, "ascii")} >>\nstream\nBT /F1 16 Tf 40 700 Td (${text}) Tj ET\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

it.effect(
  "manages secrets in ServerSecretStore, deletion approvals, Telegram toggle, and exports import to LibraryService",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wagent-service-" });
        const homeDir = path.join(tempDir, "home");
        const exportsDir = path.join(homeDir, "Wagent", "exports");
        yield* fs.makeDirectory(exportsDir, { recursive: true });
        const fixtureMdPath = path.join(exportsDir, "exported-note.md");
        const fixturePdfPath = path.join(exportsDir, "exported-paper.pdf");
        const fixtureMdContent = "# Exported Note\n\nWagent converted content.";
        yield* fs.writeFileString(fixtureMdPath, fixtureMdContent);
        yield* fs.writeFile(fixturePdfPath, buildMinimalValidPdf("Wagent Export PDF"));
        const envId = EnvironmentId.make("env-wagent-test");

        const telegramTokensStarted: string[] = [];
        const fakeTelegramFactory = (token: string): TelegramPort => {
          telegramTokensStarted.push(token);
          return {
            getUpdates: (_offset, _timeoutSec, signal) =>
              new Promise((resolve) => {
                signal?.addEventListener("abort", () => resolve([]), { once: true });
              }),
            sendMessage: async () => ({ message_id: 1 }),
            editMessageText: async () => undefined,
            deleteMessage: async () => undefined,
            sendChatAction: async () => undefined,
            answerCallbackQuery: async () => undefined,
            sendDocument: async () => undefined,
            downloadFile: async (_id, destDir, name) => path.join(destDir, name ?? "a.bin"),
          };
        };

        const seenSecrets: Array<{ deepseek?: string | undefined; wkb?: string | undefined }> = [];
        const executor: WagentExecutor = {
          async run(input) {
            seenSecrets.push({
              deepseek: input.secrets.deepseekApiKey,
              wkb: input.secrets.wkbToken,
            });
            input.callbacks.onTool("bash ls");
            if (input.prompt.includes("NEED_APPROVAL")) {
              const allowed = await input.callbacks.requestApproval({
                reason: "删除文件或目录",
                command: "rm -rf ~/Wagent/tmp",
              });
              input.callbacks.onText(allowed ? "APPROVED_AND_DONE" : "DENIED_BY_OWNER");
              return;
            }
            input.callbacks.onText(`completed:${input.prompt}`);
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
          telegramFactory: fakeTelegramFactory,
          approvalTimeoutOverrideMs: 5_000,
          wkbExportImpl: async (input) => ({
            title: "Exported Note",
            markdownPath: fixtureMdPath,
            markdown: fixtureMdContent,
            pdfPath: input.pdf ? fixturePdfPath : null,
            warnings: [],
            inferredKind: "web",
            sourceUrl: input.source,
          }),
        }).pipe(
          Layer.provide(baseConfigLayer),
          Layer.provide(secretStoreLayer),
          Layer.provide(libraryLayer),
          Layer.provide(wkbLayer),
        );

        const testLayer = Layer.mergeAll(
          baseConfigLayer,
          secretStoreLayer,
          libraryLayer,
          wagentLayer,
        ).pipe(
          Layer.provide(Layer.succeed(HostProcess.HomeDirectory, homeDir)),
          Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, tempDir)),
        );

        yield* Effect.gen(function* () {
          const wagent = yield* WagentService.WagentService;
          const library = yield* LibraryService.LibraryService;
          const secretStore = yield* ServerSecretStore.ServerSecretStore;

          // 1. Update secrets & enable Telegram channel — secrets stored in ServerSecretStore, masked in status
          const updated = yield* wagent.updateConfig({
            kbUrl: "https://kb.example.invalid/kb/mcp",
            telegramEnabled: true,
            allowedUserIds: [777],
            telegramBotToken: "123456:fake-tg-token",
            deepseekApiKey: "sk-deepseek-secret",
            wkbToken: "wkb-bearer-secret",
          });
          expect(updated.status.telegramConnected).toBe(true);
          expect(updated.status.config.hasTelegramBotToken).toBe(true);
          expect(updated.status.config.hasDeepseekApiKey).toBe(true);
          expect(updated.status.config.hasWkbToken).toBe(true);
          expect(JSON.stringify(updated.status)).not.toContain("fake-tg-token");
          expect(JSON.stringify(updated.status)).not.toContain("sk-deepseek-secret");
          expect(JSON.stringify(updated.status)).not.toContain("wkb-bearer-secret");
          expect(telegramTokensStarted).toEqual(["123456:fake-tg-token"]);

          const storedKey = yield* secretStore.get("wagent-deepseek-api-key");
          expect(Option.isSome(storedKey)).toBe(true);

          // 2. Dispatch run that triggers deletion approval; listen via PubSub subscription
          const subscription = yield* wagent.subscribe;
          yield* wagent.send({ prompt: "NEED_APPROVAL cleanup" }, { source: "ui" });

          let approvalId: string | null = null;
          while (approvalId === null) {
            const event = yield* PubSub.take(subscription);
            if (event.type === "approval_requested") {
              approvalId = event.approval.id;
            }
          }
          expect(approvalId).toBeTruthy();

          const decided = yield* wagent.decideApproval({ approvalId, allow: true });
          expect(decided.approval.status).toBe("approved");
          expect(decided.approval.decidedBy).toBe("ui");

          let finishedOutput = "";
          while (!finishedOutput) {
            const event = yield* PubSub.take(subscription);
            if (event.type === "run_finished") {
              finishedOutput = event.run.output;
            }
          }
          expect(finishedOutput).toBe("APPROVED_AND_DONE");
          expect(seenSecrets[0]).toEqual({
            deepseek: "sk-deepseek-secret",
            wkb: "wkb-bearer-secret",
          });

          // 3. Convert doc into exports/ and one-click import both Markdown and PDF into LibraryService
          const converted = yield* wagent.convertToDoc({
            source: "https://example.com/paper",
            pdf: true,
          });
          expect(converted.savedFiles).toHaveLength(2);

          const mdFile = converted.savedFiles.find((file) => file.kind === "markdown")!;
          const pdfFile = converted.savedFiles.find((file) => file.kind === "pdf")!;

          const importedMd = yield* wagent.importExportToLibrary({
            relativePath: mdFile.relativePath,
            tags: ["wagent", "notes"],
          });
          expect(importedMd.entry.kind).toBe("file");
          expect(importedMd.entry.body).toContain("Wagent converted content.");

          const importedPdf = yield* wagent.importExportToLibrary({
            relativePath: pdfFile.relativePath,
            title: "Wagent Exported PDF",
          });
          expect(importedPdf.entry.kind).toBe("pdf");
          expect(importedPdf.entry.title).toBe("Wagent Exported PDF");
          expect(importedPdf.entry.blobSha256).toBeTruthy();

          const fetchedPdf = yield* library.get({ id: importedPdf.entry.id });
          expect(fetchedPdf.entry.blobMissing).toBe(false);
          expect(fetchedPdf.entry.pageCount).toBe(1);

          // 4. Invalid config update fails BEFORE mutating stored secrets (#31)
          const failedConfig = yield* wagent
            .updateConfig({
              confirmTimeoutSec: 1, // invalid (< 10)
              deepseekApiKey: "sk-should-not-replace-valid-key",
            })
            .pipe(Effect.result);
          expect(failedConfig._tag).toBe("Failure");
          const preservedKey = yield* secretStore.get("wagent-deepseek-api-key");
          expect(Option.isSome(preservedKey)).toBe(true);
          expect(new TextDecoder().decode(Option.getOrThrow(preservedKey))).toBe(
            "sk-deepseek-secret",
          );

          // 5. Clearing secret removes it and disables Telegram channel
          const cleared = yield* wagent.updateConfig({
            telegramBotToken: null,
            telegramEnabled: false,
          });
          expect(cleared.status.config.hasTelegramBotToken).toBe(false);
          expect(cleared.status.telegramConnected).toBe(false);
        }).pipe(Effect.provide(testLayer));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses unmigrated plaintext wkb tokens on missing/corrupt config.json and attempts all secret rollbacks on failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wagent-sec-bind-" });
        const homeDir = path.join(tempDir, "home");
        const envId = EnvironmentId.make("env-wagent-bind");

        const capturedDispatch: Array<{ kbUrl: string; wkbToken?: string | undefined }> = [];
        const executor: WagentExecutor = {
          async run(input) {
            capturedDispatch.push({
              kbUrl: input.config.kbUrl,
              wkbToken: input.secrets.wkbToken,
            });
            input.callbacks.onText("ok");
          },
        };

        const rawMap = new Map<string, Uint8Array>();
        rawMap.set("wagent-wkb-token", new TextEncoder().encode("legacy-plaintext-wkb-token"));

        let failThirdSet = false;
        let setCallCount = 0;

        const customSecretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (key) => Effect.succeed(Option.fromNullishOr(rawMap.get(key))),
          set: (key, value) =>
            Effect.gen(function* () {
              const idx = setCallCount;
              setCallCount += 1;
              if (failThirdSet && idx === 2) {
                return yield* new ServerSecretStore.SecretStorePersistError({
                  resource: key,
                  cause: new Error(`simulated restore failure for ${key}`),
                });
              }
              rawMap.set(key, value);
            }),
          remove: (key) =>
            Effect.sync(() => {
              rawMap.delete(key);
            }),
        });

        const baseConfigLayer = ServerConfig.layerTest(tempDir, tempDir);
        const wkbLayer = WkbBridgeService.layer.pipe(
          Layer.provide(baseConfigLayer),
          Layer.provide(customSecretStoreLayer),
        );
        const libraryLayer = LibraryService.layer.pipe(
          Layer.provide(baseConfigLayer),
          Layer.provide(wkbLayer),
          Layer.provide(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(envId),
            }),
          ),
        );

        const buildWagent = () =>
          Layer.build(
            WagentService.makeLayer({ executor }).pipe(
              Layer.provide(baseConfigLayer),
              Layer.provide(customSecretStoreLayer),
              Layer.provide(libraryLayer),
              Layer.provide(wkbLayer),
              Layer.provide(Layer.succeed(HostProcess.HomeDirectory, homeDir)),
              Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, tempDir)),
            ),
          );

        // 1. Missing config.json: legacy plaintext token MUST NOT be sent even when form echoes unchanged default kbUrl
        const ctxMissing = yield* buildWagent();
        const wagentMissing = ctxMissing.mapUnsafe.get(
          WagentService.WagentService.key,
        ) as WagentService.WagentService["Service"];
        const statusMissing = yield* wagentMissing.status;
        expect(statusMissing.config.hasWkbToken).toBe(false);
        const afterTimeoutSave = yield* wagentMissing.updateConfig({
          kbUrl: statusMissing.config.kbUrl,
          confirmTimeoutSec: 120,
        });
        expect(afterTimeoutSave.status.config.hasWkbToken).toBe(false);
        yield* wagentMissing.send({ prompt: "probe-missing" }, { awaitCompletion: true });
        expect(capturedDispatch[0]?.wkbToken).toBeUndefined();

        // 1b. Restarting after form save with unchanged default kbUrl still refuses unmigrated plaintext token
        const ctxRestarted = yield* buildWagent();
        const wagentRestarted = ctxRestarted.mapUnsafe.get(
          WagentService.WagentService.key,
        ) as WagentService.WagentService["Service"];
        expect((yield* wagentRestarted.status).config.hasWkbToken).toBe(false);
        yield* wagentRestarted.send({ prompt: "probe-restarted" }, { awaitCompletion: true });
        expect(capturedDispatch[1]?.wkbToken).toBeUndefined();

        // 2. Corrupt config.json: legacy plaintext token MUST NOT be sent even after saving unrelated settings
        const wagentCfgDir = path.join(tempDir, "userdata", "wagent");
        yield* fs.makeDirectory(wagentCfgDir, { recursive: true });
        yield* fs.writeFileString(path.join(wagentCfgDir, "config.json"), "{corrupt-json");
        const ctxCorrupt = yield* buildWagent();
        const wagentCorrupt = ctxCorrupt.mapUnsafe.get(
          WagentService.WagentService.key,
        ) as WagentService.WagentService["Service"];
        const afterCorruptSave = yield* wagentCorrupt.updateConfig({
          kbUrl: statusMissing.config.kbUrl,
          confirmTimeoutSec: 180,
        });
        expect(afterCorruptSave.status.config.hasWkbToken).toBe(false);
        yield* wagentCorrupt.send({ prompt: "probe-corrupt" }, { awaitCompletion: true });
        expect(capturedDispatch[2]?.wkbToken).toBeUndefined();

        // 3. Multi-key rollback continues restoring remaining keys even if one restore dies with a defect
        yield* fs.remove(path.join(wagentCfgDir, "config.json"), { force: true });
        rawMap.set("wagent-deepseek-api-key", new TextEncoder().encode("prev-deepseek"));
        rawMap.set("wagent-telegram-bot-token", new TextEncoder().encode("prev-tg"));
        let dieOnFirstRollback = false;
        const defectStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (key) => Effect.succeed(Option.fromNullishOr(rawMap.get(key))),
          set: (key, value) =>
            Effect.gen(function* () {
              const idx = setCallCount;
              setCallCount += 1;
              if (dieOnFirstRollback && idx === 4) {
                return yield* Effect.die(new Error(`defect restoring ${key}`));
              }
              if (failThirdSet && idx === 2) {
                return yield* new ServerSecretStore.SecretStorePersistError({
                  resource: key,
                  cause: new Error(`simulated restore failure for ${key}`),
                });
              }
              rawMap.set(key, value);
            }),
          remove: (key) =>
            Effect.sync(() => {
              rawMap.delete(key);
            }),
        });
        const ctxRollback = yield* Layer.build(
          WagentService.makeLayer({ executor }).pipe(
            Layer.provide(baseConfigLayer),
            Layer.provide(defectStoreLayer),
            Layer.provide(libraryLayer),
            Layer.provide(wkbLayer),
            Layer.provide(Layer.succeed(HostProcess.HomeDirectory, homeDir)),
            Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, tempDir)),
          ),
        );
        const wagentRollback = ctxRollback.mapUnsafe.get(
          WagentService.WagentService.key,
        ) as WagentService.WagentService["Service"];

        // Make config.json path a directory so writing config.json fails AFTER secret writes succeed
        yield* fs.makeDirectory(path.join(wagentCfgDir, "config.json"), { recursive: true });
        failThirdSet = true;
        setCallCount = 0;

        const failedUpdate = yield* wagentRollback
          .updateConfig({
            telegramBotToken: "new-tg",
            deepseekApiKey: "new-deepseek",
          })
          .pipe(Effect.result);
        expect(failedUpdate._tag).toBe("Failure");
        expect(new TextDecoder().decode(rawMap.get("wagent-telegram-bot-token")!)).toBe("prev-tg");

        // 4. Even an Effect.die defect on the 1st rollback key still restores subsequent keys, and 4-key failure preserves all 4 names
        failThirdSet = false;
        dieOnFirstRollback = true;
        setCallCount = 2;
        rawMap.set("wagent-deepseek-api-key", new TextEncoder().encode("prev-deepseek-2"));
        rawMap.set("wagent-telegram-bot-token", new TextEncoder().encode("prev-tg-2"));
        const defectUpdate = yield* wagentRollback
          .updateConfig({
            telegramBotToken: "mut-tg",
            deepseekApiKey: "mut-ds",
          })
          .pipe(Effect.result);
        expect(defectUpdate._tag).toBe("Failure");
        expect(new TextDecoder().decode(rawMap.get("wagent-telegram-bot-token")!)).toBe(
          "prev-tg-2",
        );

        // 5. All 4 keys failing with >120-char errors still produces a valid <=400-char WagentRuntimeError listing all 4 keys
        const fourKeyFailLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (key) => Effect.succeed(Option.fromNullishOr(rawMap.get(key))),
          set: (key, value) =>
            Effect.gen(function* () {
              const idx = setCallCount;
              setCallCount += 1;
              if (idx >= 4) {
                return yield* new ServerSecretStore.SecretStorePersistError({
                  resource: `${key}-${"x".repeat(120)}`,
                  cause: new Error("disk error"),
                });
              }
              rawMap.set(key, value);
            }),
          remove: () => Effect.void,
        });
        rawMap.set("wagent-proxy-url", new TextEncoder().encode("http://u:p@127.0.0.1:7890"));
        const ctxFour = yield* Layer.build(
          WagentService.makeLayer({ executor }).pipe(
            Layer.provide(baseConfigLayer),
            Layer.provide(fourKeyFailLayer),
            Layer.provide(libraryLayer),
            Layer.provide(wkbLayer),
            Layer.provide(Layer.succeed(HostProcess.HomeDirectory, homeDir)),
            Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, tempDir)),
          ),
        );
        const wagentFour = ctxFour.mapUnsafe.get(
          WagentService.WagentService.key,
        ) as WagentService.WagentService["Service"];
        setCallCount = 0;
        const fourErr = yield* wagentFour
          .updateConfig({
            kbUrl: "https://kb.example.invalid/kb/mcp",
            telegramBotToken: "t1",
            deepseekApiKey: "d1",
            wkbToken: "w1",
            proxy: "http://u2:p2@127.0.0.1:7890",
          })
          .pipe(Effect.flip);
        expect(fourErr._tag).toBe("WagentRuntimeError");
        expect(fourErr.message.length).toBeLessThanOrEqual(400);
        expect(fourErr.message).toContain("wagent-telegram-bot-token");
        expect(fourErr.message).toContain("wagent-deepseek-api-key");
        expect(fourErr.message).toContain("wagent-wkb-token");
        expect(fourErr.message).toContain("wagent-proxy-url");

        // 6. Concurrent expectedKbUrl conflict rejects stale token write/clear before mutating B's endpoint or token
        yield* fs.remove(path.join(wagentCfgDir, "config.json"), { recursive: true, force: true });
        const cleanStore = new Map<string, Uint8Array>();
        const cleanSecretLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (key) => Effect.succeed(Option.fromNullishOr(cleanStore.get(key))),
          set: (key, value) =>
            Effect.sync(() => {
              cleanStore.set(key, value);
            }),
          remove: (key) =>
            Effect.sync(() => {
              cleanStore.delete(key);
            }),
        });
        const ctxCas = yield* Layer.build(
          WagentService.makeLayer({ executor }).pipe(
            Layer.provide(baseConfigLayer),
            Layer.provide(cleanSecretLayer),
            Layer.provide(libraryLayer),
            Layer.provide(wkbLayer),
            Layer.provide(Layer.succeed(HostProcess.HomeDirectory, homeDir)),
            Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, tempDir)),
          ),
        );
        const wagentCas = ctxCas.mapUnsafe.get(
          WagentService.WagentService.key,
        ) as WagentService.WagentService["Service"];
        const initialUrl = (yield* wagentCas.status).config.kbUrl;
        const savedB = yield* wagentCas.updateConfig({
          kbUrl: "https://client-b.example.invalid/kb/mcp",
          wkbToken: "token-from-b",
          expectedKbUrl: initialUrl,
        });
        expect(savedB.status.config.hasWkbToken).toBe(true);
        const bBytesBefore = Uint8Array.from(cleanStore.get("wagent-wkb-token")!);

        const conflictWrite = yield* wagentCas
          .updateConfig({
            wkbToken: "stale-token-from-a",
            expectedKbUrl: initialUrl,
          })
          .pipe(Effect.flip);
        expect(conflictWrite._tag).toBe("WagentValidationError");

        const conflictClear = yield* wagentCas
          .updateConfig({
            wkbToken: null,
            expectedKbUrl: initialUrl,
          })
          .pipe(Effect.flip);
        expect(conflictClear._tag).toBe("WagentValidationError");

        const statusAfterConflict = yield* wagentCas.status;
        expect(statusAfterConflict.config.kbUrl).toBe("https://client-b.example.invalid/kb/mcp");
        expect(statusAfterConflict.config.hasWkbToken).toBe(true);
        expect(Uint8Array.from(cleanStore.get("wagent-wkb-token")!)).toEqual(bBytesBefore);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

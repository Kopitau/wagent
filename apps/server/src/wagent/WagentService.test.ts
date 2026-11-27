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

          // 4. Clearing secret removes it and disables Telegram channel
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

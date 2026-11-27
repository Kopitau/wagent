// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Unit tests for pure non-Effect wagent-bridge package.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ApprovalHub,
  DELETION_RULE_SPECS,
  TelegramChannel,
  WagentBridgeError,
  WagentRuntime,
  chunks,
  deletionReason,
} from "./index.ts";
import type { TelegramPort, WagentExecutor } from "./index.ts";

const tempDirs: Array<string> = [];

async function makeTempDir(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wagent-bridge-test-"));
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

describe("guard.ts deletion rules", () => {
  it("exports all 27 ported deletion rules and flags destructive commands", () => {
    expect(DELETION_RULE_SPECS).toHaveLength(27);

    const dangerous: ReadonlyArray<readonly [string, string]> = [
      ["rm -rf ./tmp", "删除文件或目录"],
      ["sudo unlink /tmp/a", "删除文件或目录"],
      ["find . -name '*.log' -delete", "find 批量删除"],
      ["ls | xargs /bin/rm -f", "xargs 批量删除"],
      ["git clean -fd", "git 删除文件"],
      ["git reset --hard HEAD~1", "git 丢弃改动"],
      ["git checkout -- file.ts", "git 丢弃改动"],
      ["git restore src/index.ts", "git 丢弃改动"],
      ["git branch -D old-feature", "删除 git 分支"],
      ["git stash drop", "删除 git stash"],
      ["git push origin --delete feat", "删除远程分支"],
      ["rsync -av --delete a/ b/", "rsync 同步删除"],
      ["docker system prune -af", "删除容器/镜像/卷"],
      ["kubectl delete pod web-1", "kubectl 删除资源"],
      ["brew uninstall jq", "卸载软件"],
      ["pnpm remove lodash", "卸载依赖"],
      ["uv pip uninstall requests", "卸载依赖"],
      ["uv cache clean", "卸载依赖"],
      ["diskutil eraseDisk APFS Test disk2", "抹掉磁盘"],
      ["dd if=/dev/zero of=/dev/disk2", "dd 覆写"],
      ["sqlite3 app.db 'DROP TABLE entries;'", "删除数据库数据"],
      ["python3 -c 'import shutil; shutil.rmtree(\"x\")'", "脚本里删除文件"],
      ["mv notes.txt ~/.Trash/", "移到废纸篓"],
      ["truncate -s 0 app.log", "清空文件"],
      ["osascript -e 'tell app \"Finder\" to delete file x'", "AppleScript 删除"],
      ["crontab -r", "删除定时任务"],
      ["security delete-generic-password -s foo", "删除钥匙串条目"],
      ["launchctl bootout gui/501/com.example", "移除后台服务"],
    ];

    for (const [command, expectedReason] of dangerous) {
      expect(deletionReason(command), command).toBe(expectedReason);
    }

    const safeCommands = [
      "ls -la ~/Wagent",
      "git status",
      "cat README.md",
      "python3 -c 'print(\"hello\")'",
      "echo 'formatting' > notes.txt",
    ];
    for (const command of safeCommands) {
      expect(deletionReason(command), command).toBeNull();
    }
  });
});

describe("ApprovalHub", () => {
  it("resolves first decision and rejects duplicate decisions", async () => {
    const hub = new ApprovalHub();
    const { approval, decision } = hub.requestApproval({
      runId: "run-1",
      reason: "删除文件或目录",
      command: "rm -rf foo",
      timeoutMs: 5_000,
    });

    expect(hub.listPending()).toHaveLength(1);
    const resolved = hub.decide(approval.id, true, "ui");
    expect(resolved.status).toBe("approved");
    expect(resolved.decidedBy).toBe("ui");
    expect(await decision).toBe(true);
    expect(hub.listPending()).toHaveLength(0);

    expect(hub.tryDecide(approval.id, false, "telegram")).toBeNull();
    expect(() => hub.decide(approval.id, false, "ui")).toThrowError(WagentBridgeError);
    hub.dispose();
  });

  it("auto-denies on timeout and supports cancelForRun", async () => {
    const hub = new ApprovalHub();
    const timed = hub.requestApproval({
      runId: "run-timeout",
      reason: "删除文件或目录",
      command: "rm a",
      timeoutMs: 60,
    });
    expect(await timed.decision).toBe(false);

    const cancellable = hub.requestApproval({
      runId: "run-cancel",
      reason: "清空文件",
      command: "truncate -s 0 x",
      timeoutMs: 5_000,
    });
    const cancelled = hub.cancelForRun("run-cancel");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.status).toBe("cancelled");
    expect(await cancellable.decision).toBe(false);
    hub.dispose();
  });
});

describe("TelegramChannel dual-surface sync and pairing", () => {
  it("chunks long messages cleanly on newlines", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(2000)}`;
    const parts = chunks(text, 4000);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.endsWith("\n")).toBe(true);
    expect(parts.join("")).toBe(text);
  });

  it("enforces pairing allowlist and synchronizes deletion approvals across UI and Telegram", async () => {
    const sentMessages: Array<{
      chatId: number;
      text: string;
      messageId: number;
      hasKeyboard: boolean;
    }> = [];
    const editedMessages: Array<{ chatId: number; messageId: number; text: string }> = [];
    const answeredCallbacks: Array<{ id: string; text?: string }> = [];
    let nextMessageId = 100;
    const sentWaiters: Array<() => void> = [];
    const editWaiters: Array<() => void> = [];
    const waitForNextSent = () =>
      new Promise<void>((resolve) => {
        sentWaiters.push(resolve);
      });
    const waitForNextEdit = () =>
      new Promise<void>((resolve) => {
        editWaiters.push(resolve);
      });

    const fakeTelegram: TelegramPort = {
      getUpdates: async (_offset, _timeoutSec, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve([]), { once: true });
        }),
      sendMessage: async (chatId, text, extra) => {
        const messageId = nextMessageId++;
        sentMessages.push({
          chatId,
          text,
          messageId,
          hasKeyboard: Boolean(extra?.reply_markup?.inline_keyboard.length),
        });
        sentWaiters.shift()?.();
        return { message_id: messageId };
      },
      editMessageText: async (chatId, messageId, text) => {
        editedMessages.push({ chatId, messageId, text });
        editWaiters.shift()?.();
      },
      deleteMessage: async () => undefined,
      sendChatAction: async () => undefined,
      answerCallbackQuery: async (id, text) => {
        answeredCallbacks.push({ id, ...(text ? { text } : {}) });
      },
      sendDocument: async () => undefined,
      downloadFile: async (_fileId, destDir, preferredName) =>
        NodePath.join(destDir, preferredName ?? "downloaded.bin"),
    };

    const hub = new ApprovalHub();
    const fixedTs = "2026-01-01T00:00:00.000Z";
    const channel = new TelegramChannel({
      telegram: fakeTelegram,
      approvalHub: hub,
      runtime: {
        getAllowedUserIds: () => [42],
        getInboxDir: () => "/tmp/inbox",
        getSummaryStatus: () => "运行中：否",
        dispatchFromTelegram: ({ prompt }) => ({
          runId: "run-tg",
          completed: Promise.resolve({
            id: "run-tg",
            prompt,
            source: "telegram",
            status: "completed",
            createdAt: fixedTs,
            updatedAt: fixedTs,
            completedAt: fixedTs,
            output: `echo: ${prompt}`,
            error: null,
            steps: [],
          }),
        }),
        abortActive: async () => false,
        resetSession: async () => undefined,
      },
    });
    channel.start();

    // Unauthorized user rejected
    await channel.processUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: 999 },
        chat: { id: 999 },
        text: "hello",
      },
    });
    expect(sentMessages.at(-1)?.text).toContain("未授权用户");

    // Authorized user command
    await channel.processUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: 42 },
        chat: { id: 42 },
        text: "/status",
      },
    });
    expect(sentMessages.at(-1)?.text).toContain("运行中：否");

    // Approval requested from UI run -> Telegram sends inline keyboard -> UI approves -> Telegram edits message
    const firstSent = waitForNextSent();
    const first = hub.requestApproval({
      runId: "run-ui-1",
      reason: "删除文件或目录",
      command: "rm -rf old_cache",
      timeoutMs: 5_000,
    });
    await firstSent;
    expect(sentMessages.at(-1)?.hasKeyboard).toBe(true);
    expect(sentMessages.at(-1)?.chatId).toBe(42);

    const firstEdited = waitForNextEdit();
    hub.decide(first.approval.id, true, "ui");
    expect(await first.decision).toBe(true);
    await firstEdited;
    expect(editedMessages.at(-1)?.text).toContain("✅ 已允许（T3 UI）");

    // Approval settled via Telegram callback button
    const secondSent = waitForNextSent();
    const second = hub.requestApproval({
      runId: "run-ui-2",
      reason: "git 丢弃改动",
      command: "git reset --hard",
      timeoutMs: 5_000,
    });
    await secondSent;
    const secondEdited = waitForNextEdit();
    await channel.processUpdate({
      update_id: 3,
      callback_query: {
        id: "cb-1",
        from: { id: 42 },
        data: `no:${second.approval.id}`,
      },
    });
    expect(await second.decision).toBe(false);
    expect(answeredCallbacks.at(-1)?.text).toBe("已拒绝");
    await secondEdited;
    expect(editedMessages.at(-1)?.text).toContain("❌ 已拒绝（Telegram）");

    await channel.stop();
    hub.dispose();
  });
});

describe("WagentRuntime", () => {
  it("queues runs serially, handles deletion approvals, protects exports containment, and converts docs", async () => {
    const base = await makeTempDir();
    const stateDir = NodePath.join(base, "state");
    const homeDir = NodePath.join(base, "home");

    const executor: WagentExecutor = {
      async run(input) {
        input.callbacks.onTool("bash ls");
        if (input.prompt.includes("DELETE_TEST")) {
          const reason = deletionReason("rm -rf /tmp/demo") ?? "删除文件或目录";
          const allowed = await input.callbacks.requestApproval({
            reason,
            command: "rm -rf /tmp/demo",
          });
          input.callbacks.onText(allowed ? "deleted" : "blocked-by-owner");
          return;
        }
        input.callbacks.onText(`done:${input.prompt}`);
      },
    };

    const runtime = new WagentRuntime({
      stateDir,
      homeDir,
      getSecrets: async () => ({}),
      executor,
      approvalTimeoutOverrideMs: 5_000,
      wkbExportImpl: async (input) => {
        const fakeMd = NodePath.join(input.outDir, "attention-paper.md");
        const fakePdf = NodePath.join(input.outDir, "attention-paper.pdf");
        await NodeFSP.writeFile(fakeMd, "# Attention Paper\n\nSummary text.", "utf8");
        if (input.pdf) {
          await NodeFSP.writeFile(fakePdf, "%PDF-1.4\n%fake\n");
        }
        return {
          title: "Attention Paper",
          sourceUrl: input.source,
          inferredKind: "web",
          markdown: "# Attention Paper\n\nSummary text.",
          markdownPath: fakeMd,
          pdfPath: input.pdf ? fakePdf : null,
          warnings: [],
        };
      },
    });

    // Run requiring deletion approval -> approve from UI
    const approvalRequested = new Promise<string>((resolve) => {
      const unsubscribe = runtime.approvalHub.subscribe((event) => {
        if (event.type === "approval_requested") {
          unsubscribe();
          resolve(event.approval.id);
        }
      });
    });
    const approvalRun = runtime.enqueue({
      prompt: "DELETE_TEST please",
      source: "ui",
    });

    const approvalId = await approvalRequested;
    expect(approvalId).toBeTruthy();

    // Busy session refuses newSession
    await expect(runtime.newSession()).rejects.toThrowError(WagentBridgeError);

    runtime.decideApproval(approvalId, false, "ui");
    const finished = await approvalRun.completed;
    expect(finished.status).toBe("completed");
    expect(finished.output).toBe("blocked-by-owner");

    // Idle session rotates cleanly
    const nextSessionId = await runtime.newSession();
    expect(nextSessionId).toBeTruthy();

    // convertToDoc saves md + pdf into workspace/exports
    const converted = await runtime.convertToDoc({
      source: "https://example.com/article",
      pdf: true,
    });
    expect(converted.savedFiles).toHaveLength(2);
    expect(converted.savedFiles.some((file) => file.kind === "markdown")).toBe(true);
    expect(converted.savedFiles.some((file) => file.kind === "pdf")).toBe(true);

    const snapshot = await runtime.getSnapshot();
    expect(snapshot.exports).toHaveLength(2);

    // Path traversal & symlink escape rejected
    await expect(runtime.resolveExportFile("../secret.txt")).rejects.toThrowError(
      WagentBridgeError,
    );
    const outsideFile = NodePath.join(base, "outside.txt");
    await NodeFSP.writeFile(outsideFile, "secret", "utf8");
    await NodeFSP.symlink(outsideFile, NodePath.join(runtime.exportsDir, "escape.txt"));
    await expect(runtime.resolveExportFile("escape.txt")).rejects.toThrowError(WagentBridgeError);

    // Config update validation & persistence
    const updated = await runtime.updateConfig({
      confirmTimeoutSec: 300,
      allowedUserIds: [12345, 12345],
      telegramEnabled: true,
    });
    expect(updated.confirmTimeoutSec).toBe(300);
    expect(updated.allowedUserIds).toEqual([12345]);
    expect(updated.telegramEnabled).toBe(true);

    await expect(runtime.updateConfig({ confirmTimeoutSec: 2 })).rejects.toThrowError(
      WagentBridgeError,
    );

    await runtime.dispose();
  });
});

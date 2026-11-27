// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Unit test exercises subprocess Pi 1.3.0 worker contract, proxy redaction, and non-blocking Telegram approvals.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  TelegramChannel,
  WagentRuntime,
  createPiSubprocessExecutor,
  sanitizeProxyUrl,
  type TelegramPort,
  type TelegramUpdate,
} from "./index.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

describe("wagent-bridge Pi 1.3.0 worker, proxy redaction, and non-blocking Telegram approvals", () => {
  it("strips credentials from stored proxy URLs so config.json and status never expose plaintext secrets", async () => {
    const root = await makeTempDir("t3-wagent-proxy-");
    const stateDir = NodePath.join(root, "state");
    const homeDir = NodePath.join(root, "home");

    const parsed = sanitizeProxyUrl("http://alice:s3cr3t-pass@127.0.0.1:7890");
    expect(parsed).toEqual({
      redacted: "http://127.0.0.1:7890",
      hasCredentials: true,
    });

    const runtime = new WagentRuntime({
      stateDir,
      homeDir,
      defaultKbDir: NodePath.join(homeDir, "kb"),
      defaultAgentDir: NodePath.join(homeDir, "agent"),
      getSecrets: async () => ({}),
      executor: { async run() {} },
    });
    try {
      await runtime.updateConfig({ proxy: "http://alice:s3cr3t-pass@127.0.0.1:7890" });
      const snap = await runtime.getSnapshot();
      expect(snap.config.proxy).toBe("http://127.0.0.1:7890");
      const persisted = await NodeFSP.readFile(NodePath.join(stateDir, "config.json"), "utf8");
      expect(persisted).not.toContain("s3cr3t-pass");
      expect(persisted).not.toContain("alice");
    } finally {
      await runtime.dispose();
    }
  });

  it("initializes Pi 1.3.0 worker via ModelRuntime.create + getModel + bindExtensions and scrubs T3CODE_* env", async () => {
    const root = await makeTempDir("t3-wagent-pi130-");
    const agentDir = NodePath.join(root, "agent");
    const stateDir = NodePath.join(root, "state");
    const workspace = NodePath.join(root, "workspace");

    const piPkgDir = NodePath.join(agentDir, "node_modules", "@earendil-works", "pi-coding-agent");
    const typeboxDir = NodePath.join(agentDir, "node_modules", "typebox");
    await NodeFSP.mkdir(piPkgDir, { recursive: true });
    await NodeFSP.mkdir(typeboxDir, { recursive: true });

    await NodeFSP.writeFile(
      NodePath.join(agentDir, "package.json"),
      JSON.stringify({ name: "fake-wagent", private: true, type: "module" }),
    );
    await NodeFSP.writeFile(
      NodePath.join(typeboxDir, "package.json"),
      JSON.stringify({ name: "typebox", main: "index.mjs", type: "module" }),
    );
    await NodeFSP.writeFile(
      NodePath.join(typeboxDir, "index.mjs"),
      `export const Type = { Object: (x) => x, String: (x) => x, Optional: (x) => x, Boolean: (x) => x };`,
    );
    // Mirror real Pi 1.3.0 packaging: ESM-only `exports` with NO `main` or `require` condition!
    await NodeFSP.writeFile(
      NodePath.join(piPkgDir, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        type: "module",
        exports: {
          ".": {
            import: "./index.mjs",
          },
        },
      }),
    );
    // Strict Pi 1.3.0 contract: `new ModelRuntime()` throws if called directly; requires `ModelRuntime.create()` + `getModel()` + `SessionManager.findById()`
    await NodeFSP.writeFile(
      NodePath.join(piPkgDir, "index.mjs"),
      `
import * as fs from "node:fs";
import * as path from "node:path";

export class ModelRuntime {
  constructor(internalToken) {
    if (internalToken !== "created-via-factory") {
      throw new Error("Direct new ModelRuntime() is unsupported in Pi 1.3.0");
    }
  }
  static async create(opts) {
    if (!opts || opts.refreshOnCreate !== false) {
      throw new Error("Expected refreshOnCreate: false");
    }
    return new ModelRuntime("created-via-factory");
  }
  getModel(provider, id) {
    return provider === "deepseek" && id === "deepseek-v4-pro" ? { provider, id } : null;
  }
}
export class DefaultResourceLoader {
  constructor(opts) { this.opts = opts; }
  async reload() {}
}
export const SessionManager = {
  findById(_workspace, knownId, sessionsDir) {
    const candidate = path.join(sessionsDir, "2026_" + knownId + ".jsonl");
    return fs.existsSync(candidate) ? candidate : null;
  },
  open(filePath, _sessionsDir) {
    const prev = fs.readFileSync(filePath, "utf8").trim();
    return {
      getSessionId: () => path.basename(filePath, ".jsonl").replace(/^2026_/, ""),
      filePath,
      resumedHistory: prev,
    };
  },
  create(_workspace, sessionsDir) {
    const id = "pi-sdk-uuid-1";
    const filePath = path.join(sessionsDir, "2026_" + id + ".jsonl");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(filePath, "turn1", "utf8");
    return {
      getSessionId: () => id,
      filePath,
      resumedHistory: "",
    };
  },
};
export const SettingsManager = {
  inMemory: (x) => x,
};
export function createMcpExtension() {
  return () => {};
}
export async function createAgentSession(opts) {
  if (!(opts.modelRuntime instanceof ModelRuntime)) {
    throw new Error("Expected modelRuntime instance");
  }
  let listener = null;
  let bound = false;
  const session = {
    extensionRunner: { hasHandlers: () => false, emit: async () => {} },
    async bindExtensions() { bound = true; },
    subscribe(fn) { listener = fn; return () => {}; },
    async prompt(text) {
      if (!bound) throw new Error("bindExtensions was not awaited");
      if (process.env.T3CODE_BOOTSTRAP_SECRET) {
        throw new Error("Leaked T3CODE_BOOTSTRAP_SECRET into worker");
      }
      const proxySeen = process.env.HTTPS_PROXY || "";
      const resumed = opts.sessionManager.resumedHistory ? ":resumed=" + opts.sessionManager.resumedHistory : "";
      listener?.({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "ok:" + text + ":proxy=" + proxySeen + resumed },
      });
    },
    async abort() {},
    dispose() {},
  };
  return { session };
}
`,
    );

    const prevSecret = process.env.T3CODE_BOOTSTRAP_SECRET;
    process.env.T3CODE_BOOTSTRAP_SECRET = "top-secret-should-not-leak";
    try {
      const executor = createPiSubprocessExecutor();
      const chunks1: string[] = [];
      const baseCfg = {
        workspace,
        // Also verifies legacy deepseek-reasoner -> deepseek-v4-pro fallback
        model: { provider: "deepseek", id: "deepseek-reasoner", thinking: "medium" as const },
        kbUrl: "https://kb.example.invalid/mcp",
        kbDir: NodePath.join(root, "kb"),
        confirmTimeoutSec: 60,
        telegramEnabled: false,
        allowedUserIds: [],
        proxy: "http://127.0.0.1:7890",
        agentDir,
      };
      await executor.run({
        runId: "run-1",
        sessionId: "sess-1",
        prompt: "hello",
        source: "ui",
        stateDir,
        config: baseCfg,
        secrets: {
          proxyUrl: "http://user:pass@127.0.0.1:7890",
          wkbToken: "wkb-tok",
        },
        signal: new AbortController().signal,
        callbacks: {
          onText: (t) => chunks1.push(t),
          onTool: () => {},
          onError: (e) => {
            throw new Error(e);
          },
          requestApproval: async () => true,
        },
      });
      expect(chunks1.join("")).toBe("ok:hello:proxy=http://user:pass@127.0.0.1:7890");

      // Second turn on the same T3 sessionId resumes Pi's timestamped session file via findById
      const chunks2: string[] = [];
      await executor.run({
        runId: "run-2",
        sessionId: "sess-1",
        prompt: "followup",
        source: "ui",
        stateDir,
        config: baseCfg,
        secrets: {},
        signal: new AbortController().signal,
        callbacks: {
          onText: (t) => chunks2.push(t),
          onTool: () => {},
          onError: (e) => {
            throw new Error(e);
          },
          requestApproval: async () => true,
        },
      });
      expect(chunks2.join("")).toBe("ok:followup:proxy=http://127.0.0.1:7890:resumed=turn1");
    } finally {
      if (prevSecret === undefined) delete process.env.T3CODE_BOOTSTRAP_SECRET;
      else process.env.T3CODE_BOOTSTRAP_SECRET = prevSecret;
    }
  });

  it("resets untrusted legacy config.json tool dirs and migrates legacy proxy credentials", async () => {
    const root = await makeTempDir("t3-wagent-legacy-cfg-");
    const stateDir = NodePath.join(root, "state");
    const homeDir = NodePath.join(root, "home");
    const defaultKbDir = NodePath.join(homeDir, "kb");
    const defaultAgentDir = NodePath.join(homeDir, "Wagent", "agent");
    await NodeFSP.mkdir(stateDir, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(stateDir, "config.json"),
      JSON.stringify({
        workspace: NodePath.join(homeDir, "Wagent"),
        // Even a subdirectory under ~/Wagent must NOT be trusted unless explicitly configured!
        agentDir: NodePath.join(homeDir, "Wagent", "untrusted-repo", "agent"),
        kbDir: NodePath.join(homeDir, "Wagent", "untrusted-repo", "kb"),
        proxy: "http://legacy:secret@127.0.0.1:7890",
      }),
      "utf8",
    );

    const runtime = new WagentRuntime({
      stateDir,
      homeDir,
      defaultKbDir,
      defaultAgentDir,
      getSecrets: async () => ({}),
      executor: { async run() {} },
    });
    try {
      expect(runtime.config.agentDir).toBe(defaultAgentDir);
      expect(runtime.config.kbDir).toBe(defaultKbDir);
      expect(runtime.config.proxy).toBe("http://127.0.0.1:7890");
      expect(runtime.consumeMigratedLegacyProxyUrl()).toBe("http://legacy:secret@127.0.0.1:7890");
      await runtime.flushPendingConfigRewrite();
      const rewritten = await NodeFSP.readFile(NodePath.join(stateDir, "config.json"), "utf8");
      expect(rewritten).not.toContain("secret");
      expect(rewritten).not.toContain("untrusted-repo");
    } finally {
      await runtime.dispose();
    }
  });

  it("validates real Pi 1.3.0 ESM package resolution and deepseek-v4-pro model lookup in a raw Node subprocess", async () => {
    const realAgentDir =
      process.env.T3CODE_WAGENT_AGENT_DIR?.trim() ||
      NodePath.join(NodeOS.homedir(), "Wagent", "agent");
    const realAgentPkg = NodePath.join(realAgentDir, "package.json");
    if (!NodeFS.existsSync(realAgentPkg)) return;
    const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
    const probeScript = `
      import * as fs from "node:fs";
      import * as path from "node:path";
      import { pathToFileURL } from "node:url";
      const pkgDir = path.join(${JSON.stringify(realAgentDir)}, "node_modules", "@earendil-works", "pi-coding-agent");
      const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      const entry = fs.realpathSync(path.resolve(pkgDir, pkgJson.exports["."].import));
      const piMod = await import(pathToFileURL(entry).href);
      const mr = await piMod.ModelRuntime.create({ refreshOnCreate: false });
      const model = mr.getModel("deepseek", "deepseek-v4-pro");
      if (!model) throw new Error("deepseek-v4-pro missing");
      process.stdout.write("REAL_PI_OK:" + model.id);
    `;
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "-e",
      probeScript,
    ]);
    expect(stdout).toBe("REAL_PI_OK:deepseek-v4-pro");
  });

  it("delivers and resolves Telegram deletion approval inline buttons without blocking the poll loop", async () => {
    const root = await makeTempDir("t3-wagent-tg-approval-");
    const sentMessages: Array<{ chatId: number; text: string; callbackData?: string }> = [];
    let approvalCallbackData: string | null = null;
    let resolveCallbackDelivered!: () => void;
    const callbackReady = new Promise<void>((resolve) => {
      resolveCallbackDelivered = resolve;
    });

    const runtime = new WagentRuntime({
      stateDir: NodePath.join(root, "state"),
      homeDir: NodePath.join(root, "home"),
      defaultKbDir: NodePath.join(root, "kb"),
      defaultAgentDir: NodePath.join(root, "agent"),
      getSecrets: async () => ({}),
      executor: {
        async run(input) {
          const allowed = await input.callbacks.requestApproval({
            reason: "rm -rf build",
            command: "rm -rf ./build",
          });
          input.callbacks.onText(allowed ? "approved-and-done" : "denied");
        },
      },
    });

    await runtime.updateConfig({ allowedUserIds: [1001] });

    let pollCount = 0;
    const fakeTelegram: TelegramPort = {
      async getUpdates(_offset, _timeout, signal) {
        pollCount += 1;
        if (pollCount === 1) {
          const first: TelegramUpdate = {
            update_id: 1,
            message: {
              message_id: 10,
              chat: { id: 1001 },
              from: { id: 1001 },
              text: "clean build folder",
            },
          };
          return [first];
        }
        if (pollCount === 2) {
          await callbackReady;
          return [
            {
              update_id: 2,
              callback_query: {
                id: "cb-1",
                from: { id: 1001 },
                data: approvalCallbackData!,
              },
            },
          ];
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return [];
      },
      async sendMessage(chatId, text, options) {
        const cb = options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
        sentMessages.push({ chatId, text, ...(cb ? { callbackData: cb } : {}) });
        if (cb) {
          approvalCallbackData = cb;
          resolveCallbackDelivered();
        }
        return { message_id: sentMessages.length + 100, chat: { id: chatId } };
      },
      async editMessageText() {},
      async deleteMessage() {},
      async answerCallbackQuery() {},
      async sendChatAction() {},
      async sendDocument() {},
      async downloadFile() {
        return "";
      },
    };

    let completedRunPromise: Promise<unknown> | null = null;
    const channel = new TelegramChannel({
      telegram: fakeTelegram,
      approvalHub: runtime.approvalHub,
      pollTimeoutSec: 1,
      runtime: {
        getAllowedUserIds: () => [1001],
        getInboxDir: () => runtime.inboxDir,
        getSummaryStatus: () => "ok",
        dispatchFromTelegram: ({ prompt }) => {
          const queued = runtime.enqueue({ prompt, source: "telegram" });
          completedRunPromise = queued.completed;
          return { runId: queued.run.id, completed: queued.completed };
        },
        abortActive: () => runtime.abort(),
        resetSession: async () => {
          await runtime.newSession();
        },
      },
    });

    try {
      channel.start();
      await callbackReady;
      expect(completedRunPromise).not.toBeNull();
      const finished = (await completedRunPromise!) as unknown as {
        status: string;
        output: string;
      };
      expect(finished.status).toBe("completed");
      expect(finished.output).toBe("approved-and-done");
    } finally {
      await channel.stop();
      await runtime.dispose();
    }
  });

  it("stops mid-batch immediately without invoking subsequent updates or passing undefined signals", async () => {
    const root = await makeTempDir("t3-wagent-tg-stop-batch-");
    const runtime = new WagentRuntime({
      stateDir: NodePath.join(root, "state"),
      homeDir: NodePath.join(root, "home"),
      defaultKbDir: NodePath.join(root, "kb"),
      defaultAgentDir: NodePath.join(root, "agent"),
      getSecrets: async () => ({}),
      executor: { async run() {} },
    });
    await runtime.updateConfig({ allowedUserIds: [1001] });

    const seenAnswerSignals: Array<AbortSignal | undefined> = [];
    const seenCallbackIds: string[] = [];
    let notifyFirstCallback!: () => void;
    const firstCallbackEntered = new Promise<void>((resolve) => {
      notifyFirstCallback = resolve;
    });
    let releaseFirstCallback!: () => void;
    const firstCallbackHold = new Promise<void>((resolve) => {
      releaseFirstCallback = resolve;
    });

    let batchReturned = false;
    const fakeTelegram: TelegramPort = {
      async getUpdates(_offset, _timeout, signal) {
        if (!batchReturned) {
          batchReturned = true;
          return [
            {
              update_id: 10,
              callback_query: { id: "cb-stop-1", from: { id: 1001 }, data: "no:missing-1" },
            },
            {
              update_id: 11,
              callback_query: { id: "cb-stop-2", from: { id: 1001 }, data: "no:missing-2" },
            },
          ];
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return [];
      },
      async sendMessage(chatId) {
        return { message_id: 1, chat: { id: chatId } };
      },
      async editMessageText() {},
      async deleteMessage() {},
      async answerCallbackQuery(id, _text, signal) {
        seenCallbackIds.push(id);
        seenAnswerSignals.push(signal);
        if (id === "cb-stop-1") {
          notifyFirstCallback();
          await firstCallbackHold;
        }
      },
      async sendChatAction() {},
      async sendDocument() {},
      async downloadFile() {
        return "";
      },
    };

    const channel = new TelegramChannel({
      telegram: fakeTelegram,
      approvalHub: runtime.approvalHub,
      pollTimeoutSec: 1,
      runtime: {
        getAllowedUserIds: () => [1001],
        getInboxDir: () => runtime.inboxDir,
        getSummaryStatus: () => "ok",
        dispatchFromTelegram: () => ({
          runId: "unused",
          completed: Promise.resolve({} as never),
        }),
        abortActive: async () => false,
        resetSession: async () => {},
      },
    });

    try {
      channel.start();
      await firstCallbackEntered;
      const stopPromise = channel.stop();
      expect(seenAnswerSignals[0]?.aborted).toBe(true);
      releaseFirstCallback();
      await stopPromise;
      expect(seenCallbackIds).toEqual(["cb-stop-1"]);
      expect(seenAnswerSignals.every((sig) => sig !== undefined)).toBe(true);
    } finally {
      await channel.stop();
      await runtime.dispose();
    }
  });
});

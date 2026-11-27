// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Isolated subprocess executor bridges Wagent Pi runtime without coupling Coding Harnesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { WagentBridgeError } from "./errors.ts";
import { DELETION_RULE_SPECS } from "./guard.ts";
import type { WagentExecutor, WagentExecutorRunInput } from "./types.ts";

const PI_WORKER_SOURCE = `
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pendingApprovals = new Map();
let activeSession = null;
let started = false;

function requestApproval(reason, command) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise((resolve) => {
    pendingApprovals.set(id, resolve);
    emit({ type: "approval_request", id, reason, command });
  });
}

async function runInit(init) {
  const agentPkg = path.join(init.config.agentDir, "package.json");
  if (!fs.existsSync(agentPkg)) {
    throw new Error("Wagent agentDir does not contain package.json: " + init.config.agentDir);
  }
  const req = createRequire(agentPkg);
  const piMod = await import(pathToFileURL(req.resolve("@earendil-works/pi-coding-agent")).href);
  const typeboxMod = await import(pathToFileURL(req.resolve("typebox")).href);
  const Type = typeboxMod.Type ?? typeboxMod.default?.Type;

  const rules = init.deletionRules.map((rule) => [new RegExp(rule.source, rule.flags), rule.label]);
  function deletionReason(cmd) {
    for (const [pattern, label] of rules) {
      if (pattern.test(cmd)) return label;
    }
    return null;
  }

  const workspace = init.config.workspace;
  const downloadsDir = path.join(workspace, "downloads");
  const exportsDir = path.join(workspace, "exports");
  const sessionsDir = path.join(init.stateDir, "sessions");
  for (const dir of [workspace, downloadsDir, path.join(workspace, "inbox"), exportsDir, sessionsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const systemPrompt = [
    "你是 Wagent，用户通过 T3 Code 调度的个人数字分身，运行在用户自己的 macOS 上。",
    "工作区: " + workspace + "（下载到 " + downloadsDir + "，导出的文档放到 " + exportsDir + "）。",
    "尽量用工具自己把事情做完，别让用户自己跑命令；回复简洁、直接说结果。",
    "严禁在未确认的情况下删除任何用户文件、数据库或分支；涉及删除的命令会被外层审批门控拦截。",
  ].join("\\n");

  const customTools = [
    {
      name: "send_file",
      label: "send_file",
      description: "Send a local file (<= 50 MiB) back to the caller/owner.",
      parameters: Type.Object({
        path: Type.String({ description: "Local absolute path" }),
        caption: Type.Optional(Type.String({ description: "Optional caption" })),
      }),
      execute: async (_id, params) => {
        const stat = fs.statSync(params.path);
        if (stat.size > 50 * 1024 * 1024) {
          throw new Error("File exceeds 50 MiB limit");
        }
        emit({ type: "send_file", path: params.path, caption: params.caption });
        return { content: [{ type: "text", text: "sent " + params.path }] };
      },
    },
    {
      name: "convert_to_doc",
      label: "convert_to_doc",
      description: "Convert a webpage, video URL, or local file into Markdown (and optional PDF) inside workspace/exports via wkb.",
      parameters: Type.Object({
        source: Type.String({ description: "URL or local file path" }),
        pdf: Type.Optional(Type.Boolean({ description: "Also generate PDF" })),
      }),
      execute: async (_id, params) => {
        const args = ["run", "--directory", init.config.kbDir, "wkb", "export", params.source, "--out", exportsDir, "--json"];
        if (params.pdf) args.push("--pdf");
        const { stdout } = await execFileAsync("uv", args, { maxBuffer: 16 * 1024 * 1024 });
        return { content: [{ type: "text", text: stdout.trim() }] };
      },
    },
  ];

  const extensionFactories = [
    (pi) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName !== "bash") return;
        const cmd = String(event.input?.command ?? "");
        const reason = deletionReason(cmd);
        if (!reason) return;
        const allowed = await requestApproval(reason, cmd);
        if (!allowed) {
          return { block: true, reason: "用户拒绝了删除操作（" + reason + "），请不要重试删除。" };
        }
      });
    },
  ];

  if (init.secrets?.wkbToken && init.config.kbUrl) {
    extensionFactories.push(
      piMod.createMcpExtension({
        wkb: {
          transport: "http",
          url: init.config.kbUrl,
          headers: { Authorization: "Bearer " + init.secrets.wkbToken },
        },
      }),
    );
  }

  const loader = new piMod.DefaultResourceLoader({
    cwd: workspace,
    systemPromptOverride: () => systemPrompt,
    extensionFactories,
  });
  await loader.reload();

  const runtime = new piMod.ModelRuntime({
    agentDir: init.stateDir,
    settingsManager: piMod.SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
  });
  const model = runtime.modelRegistry.find(init.config.model.provider, init.config.model.id);
  if (!model) {
    throw new Error("Unknown Wagent model: " + init.config.model.provider + "/" + init.config.model.id);
  }

  const sessionFile = path.join(sessionsDir, init.sessionId + ".jsonl");
  const sessionManager = fs.existsSync(sessionFile)
    ? piMod.SessionManager.open(sessionFile)
    : piMod.SessionManager.create(workspace, sessionsDir);

  const { session } = await piMod.createAgentSession({
    cwd: workspace,
    model,
    thinkingLevel: init.config.model.thinking,
    resourceLoader: loader,
    customTools,
    sessionManager,
    authStorage: runtime.authStorage,
    modelRegistry: runtime.modelRegistry,
  });
  activeSession = session;

  let textOut = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      textOut += event.assistantMessageEvent.delta;
      emit({ type: "text", text: event.assistantMessageEvent.delta });
    } else if (event.type === "tool_execution_start") {
      const cmd = event.args?.command ? " " + String(event.args.command).slice(0, 80) : "";
      emit({ type: "tool", label: String(event.toolName ?? "tool") + cmd });
    }
  });

  try {
    await session.prompt(init.prompt);
    emit({ type: "done", output: textOut });
  } finally {
    unsubscribe();
    await session.dispose?.();
    activeSession = null;
  }
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.type === "init" && !started) {
    started = true;
    runInit(message).catch((error) => {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }).finally(() => {
      rl.close();
    });
    return;
  }
  if (message.type === "approval_decision") {
    const resolve = pendingApprovals.get(message.id);
    if (resolve) {
      pendingApprovals.delete(message.id);
      resolve(Boolean(message.allow));
    }
    return;
  }
  if (message.type === "abort") {
    activeSession?.abort?.().catch(() => undefined);
    for (const resolve of pendingApprovals.values()) {
      resolve(false);
    }
    pendingApprovals.clear();
  }
});
`;

async function ensureWorkerScript(stateDir: string): Promise<string> {
  await NodeFSP.mkdir(stateDir, { recursive: true });
  const scriptPath = NodePath.join(stateDir, "pi-worker.mjs");
  await NodeFSP.writeFile(scriptPath, PI_WORKER_SOURCE, "utf8");
  return scriptPath;
}

export function createPiSubprocessExecutor(options?: {
  readonly nodeExecutable?: string;
}): WagentExecutor {
  const nodeExecutable = options?.nodeExecutable ?? process.execPath;

  return {
    async run(input: WagentExecutorRunInput): Promise<void> {
      const agentPkgPath = NodePath.join(input.config.agentDir, "package.json");
      if (!NodeFS.existsSync(agentPkgPath)) {
        throw new WagentBridgeError(
          "unavailable",
          `Wagent Pi runtime is not installed at '${input.config.agentDir}'.`,
        );
      }

      const workerScript = await ensureWorkerScript(input.stateDir);
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...(input.secrets.deepseekApiKey ? { DEEPSEEK_API_KEY: input.secrets.deepseekApiKey } : {}),
        ...(input.config.proxy
          ? {
              http_proxy: input.config.proxy,
              https_proxy: input.config.proxy,
              HTTP_PROXY: input.config.proxy,
              HTTPS_PROXY: input.config.proxy,
            }
          : {}),
      };

      await new Promise<void>((resolve, reject) => {
        const child = NodeChildProcess.spawn(nodeExecutable, [workerScript], {
          cwd: input.config.workspace,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stderr = "";
        let settled = false;
        let lastError: string | null = null;
        let killTimer: ReturnType<typeof setTimeout> | null = null;

        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (killTimer) clearTimeout(killTimer);
          input.signal.removeEventListener("abort", onAbort);
          if (err) reject(err);
          else resolve();
        };

        const sendToChild = (payload: unknown) => {
          if (!child.killed && child.stdin.writable) {
            child.stdin.write(`${JSON.stringify(payload)}\n`);
          }
        };

        const onAbort = () => {
          sendToChild({ type: "abort" });
          killTimer = setTimeout(() => {
            if (!child.killed) child.kill("SIGTERM");
          }, 400);
          killTimer.unref?.();
        };

        if (input.signal.aborted) {
          child.kill("SIGTERM");
          finish(new WagentBridgeError("aborted", "Wagent run was aborted before launch."));
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });

        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-8192);
        });

        const rl = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return;
          }
          if (message.type === "text" && typeof message.text === "string") {
            input.callbacks.onText(message.text);
          } else if (message.type === "tool" && typeof message.label === "string") {
            input.callbacks.onTool(message.label);
          } else if (message.type === "error" && typeof message.message === "string") {
            lastError = message.message;
            input.callbacks.onError(message.message);
          } else if (
            message.type === "send_file" &&
            typeof message.path === "string" &&
            input.callbacks.onSendFile
          ) {
            void input.callbacks.onSendFile(
              message.path,
              typeof message.caption === "string" ? message.caption : undefined,
            );
          } else if (
            message.type === "approval_request" &&
            typeof message.id === "string" &&
            typeof message.reason === "string" &&
            typeof message.command === "string"
          ) {
            const approvalId = message.id;
            void input.callbacks
              .requestApproval({ reason: message.reason, command: message.command })
              .then((allow) => {
                sendToChild({ type: "approval_decision", id: approvalId, allow });
              })
              .catch(() => {
                sendToChild({ type: "approval_decision", id: approvalId, allow: false });
              });
          }
        });

        child.on("error", (error) => {
          finish(new WagentBridgeError("runtime_failed", error.message, { cause: error }));
        });

        child.on("close", (code) => {
          rl.close();
          if (input.signal.aborted) {
            finish(new WagentBridgeError("aborted", "Wagent run was aborted."));
            return;
          }
          if (code === 0 && !lastError) {
            finish();
            return;
          }
          finish(
            new WagentBridgeError(
              "runtime_failed",
              lastError ?? (stderr.trim() || `Wagent worker exited with code ${code ?? -1}.`),
            ),
          );
        });

        sendToChild({
          type: "init",
          runId: input.runId,
          sessionId: input.sessionId,
          prompt: input.prompt,
          config: input.config,
          secrets: { wkbToken: input.secrets.wkbToken },
          stateDir: input.stateDir,
          deletionRules: DELETION_RULE_SPECS,
        });
      });
    },
  };
}

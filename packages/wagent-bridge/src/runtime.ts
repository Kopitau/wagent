// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Pure non-Effect Wagent runtime manages workspace dirs, state JSON, and exports containment.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { runWkbExport } from "@t3tools/wkb-bridge";
import type { WkbExportResult } from "@t3tools/wkb-bridge";

import { ApprovalHub } from "./approvalHub.ts";
import { WagentBridgeError } from "./errors.ts";
import { createPiSubprocessExecutor } from "./piWorker.ts";
import type {
  WagentApprovalDecisionSource,
  WagentBridgeEvent,
  WagentDispatchSource,
  WagentExecutor,
  WagentExportFile,
  WagentPendingApproval,
  WagentRunRecord,
  WagentRunStep,
  WagentSecrets,
  WagentStoredConfig,
  WagentThinkingLevel,
} from "./types.ts";

const MAX_PROMPT_LENGTH = 32_000;
const MAX_STORED_RUNS = 50;
const MAX_RUN_STEPS = 80;
const MAX_EXPORTS_LISTED = 200;

const VALID_THINKING_LEVELS: ReadonlySet<WagentThinkingLevel> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface WagentConfigPatch {
  readonly workspace?: string | undefined;
  readonly model?: Partial<WagentStoredConfig["model"]> | undefined;
  readonly kbUrl?: string | undefined;
  readonly kbDir?: string | undefined;
  readonly confirmTimeoutSec?: number | undefined;
  readonly telegramEnabled?: boolean | undefined;
  readonly allowedUserIds?: ReadonlyArray<number> | undefined;
  readonly proxy?: string | undefined;
  readonly agentDir?: string | undefined;
}

export interface WagentRuntimeSnapshot {
  readonly running: boolean;
  readonly sessionId: string;
  readonly activeRun: WagentRunRecord | null;
  readonly queuedRuns: ReadonlyArray<WagentRunRecord>;
  readonly recentRuns: ReadonlyArray<WagentRunRecord>;
  readonly pendingApprovals: ReadonlyArray<WagentPendingApproval>;
  readonly exports: ReadonlyArray<WagentExportFile>;
  readonly config: WagentStoredConfig;
  readonly agentDirReady: boolean;
  readonly kbDirReady: boolean;
}

export interface WagentRuntimeOptions {
  readonly stateDir: string;
  readonly homeDir: string;
  readonly defaultKbDir?: string | undefined;
  readonly defaultAgentDir?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly uvBinary?: string | undefined;
  readonly getSecrets: () => Promise<WagentSecrets>;
  readonly resolveExecutionContext?:
    | (() => Promise<{ readonly config: WagentStoredConfig; readonly secrets: WagentSecrets }>)
    | undefined;
  readonly executor?: WagentExecutor | undefined;
  readonly approvalTimeoutOverrideMs?: number | undefined;
  readonly wkbExportImpl?: typeof runWkbExport | undefined;
}

interface QueuedTask {
  readonly run: WagentRunRecord;
  readonly onFile?: ((filePath: string, caption?: string) => Promise<void>) | undefined;
  readonly resolveFinished: (run: WagentRunRecord) => void;
}

function defaultConfig(options: {
  readonly homeDir: string;
  readonly defaultKbDir?: string | undefined;
  readonly defaultAgentDir?: string | undefined;
}): WagentStoredConfig {
  return {
    workspace: NodePath.join(options.homeDir, "Wagent"),
    model: {
      provider: "deepseek",
      id: "deepseek-v4-pro",
      thinking: "medium",
    },
    kbUrl: "",
    kbDir: options.defaultKbDir ?? NodePath.join(options.homeDir, "kb"),
    confirmTimeoutSec: 600,
    telegramEnabled: false,
    allowedUserIds: [],
    proxy: "",
    agentDir: options.defaultAgentDir ?? NodePath.join(options.homeDir, "Wagent-agent"),
    explicitPaths: {
      kbUrl: false,
    },
  };
}

function realpathOrResolve(target: string): string {
  try {
    return NodeFS.realpathSync(target);
  } catch {
    return NodePath.resolve(target);
  }
}

function canonicalizeTrustedAgentDir(
  candidate: string,
  homeDir: string,
  defaultDir: string,
): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || !NodePath.isAbsolute(trimmed)) return null;
  let realCandidate: string;
  try {
    realCandidate = NodeFS.realpathSync(trimmed);
  } catch {
    return null;
  }
  const allowed = [
    realpathOrResolve(defaultDir),
    realpathOrResolve(NodePath.join(homeDir, "Wagent", "agent")),
    realpathOrResolve(NodePath.join(homeDir, "Wagent-agent")),
  ];
  return allowed.includes(realCandidate) ? realCandidate : null;
}

function canonicalizeTrustedKbDir(
  candidate: string,
  homeDir: string,
  defaultDir: string,
): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || !NodePath.isAbsolute(trimmed)) return null;
  let realCandidate: string;
  try {
    realCandidate = NodeFS.realpathSync(trimmed);
  } catch {
    return null;
  }
  const allowed = [
    realpathOrResolve(defaultDir),
    realpathOrResolve(NodePath.join(homeDir, "Wagent", "kb")),
    realpathOrResolve(NodePath.join(homeDir, "kb")),
  ];
  return allowed.includes(realCandidate) ? realCandidate : null;
}

function classifyExportKind(filePath: string): WagentExportFile["kind"] {
  const ext = NodePath.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".txt") return "text";
  return "other";
}

export function sanitizeProxyUrl(raw: string): {
  readonly redacted: string;
  readonly hasCredentials: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { redacted: "", hasCredentials: false };
  }
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "http:" &&
      parsed.protocol !== "https:" &&
      parsed.protocol !== "socks5:"
    ) {
      throw new WagentBridgeError("validation", "proxy must use http, https, or socks5 protocol.");
    }
    const hasCredentials = parsed.username.length > 0 || parsed.password.length > 0;
    parsed.username = "";
    parsed.password = "";
    const normalized =
      parsed.pathname === "/" && !parsed.search && !parsed.hash && !trimmed.endsWith("/")
        ? parsed.toString().replace(/\/$/u, "")
        : parsed.toString();
    return { redacted: normalized, hasCredentials };
  } catch (error) {
    if (error instanceof WagentBridgeError) throw error;
    throw new WagentBridgeError("validation", "proxy must be a valid URL.");
  }
}

function validateConfig(next: WagentStoredConfig): WagentStoredConfig {
  const workspace = next.workspace.trim();
  if (!workspace || !NodePath.isAbsolute(workspace)) {
    throw new WagentBridgeError("validation", "Wagent workspace must be an absolute path.");
  }
  const kbDir = next.kbDir.trim();
  if (!kbDir || !NodePath.isAbsolute(kbDir)) {
    throw new WagentBridgeError("validation", "Wagent kbDir must be an absolute path.");
  }
  const agentDir = next.agentDir.trim();
  if (!agentDir || !NodePath.isAbsolute(agentDir)) {
    throw new WagentBridgeError("validation", "Wagent agentDir must be an absolute path.");
  }
  if (
    !Number.isInteger(next.confirmTimeoutSec) ||
    next.confirmTimeoutSec < 10 ||
    next.confirmTimeoutSec > 3600
  ) {
    throw new WagentBridgeError(
      "validation",
      "confirmTimeoutSec must be an integer between 10 and 3600.",
    );
  }
  if (!VALID_THINKING_LEVELS.has(next.model.thinking)) {
    throw new WagentBridgeError(
      "validation",
      `Unsupported thinking level '${next.model.thinking}'.`,
    );
  }
  if (!next.model.provider.trim() || !next.model.id.trim()) {
    throw new WagentBridgeError("validation", "Model provider and id must be non-empty.");
  }
  const rawKbUrl = next.kbUrl.trim();
  let kbUrl = "";
  if (rawKbUrl) {
    let parsed: URL;
    try {
      parsed = new URL(rawKbUrl);
    } catch {
      throw new WagentBridgeError("validation", "kbUrl must be a valid HTTP/HTTPS URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new WagentBridgeError("validation", "kbUrl must use http or https protocol.");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new WagentBridgeError("validation", "kbUrl must not embed credentials.");
    }
    parsed.hash = "";
    kbUrl = parsed.toString();
  }
  const allowedUserIds = [...new Set(next.allowedUserIds)].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  const sanitizedProxy = sanitizeProxyUrl(next.proxy).redacted;
  const explicitPaths =
    next.explicitPaths?.agentDir === true ||
    next.explicitPaths?.kbDir === true ||
    typeof next.explicitPaths?.kbUrl === "boolean"
      ? {
          ...(next.explicitPaths.agentDir === true ? { agentDir: true } : {}),
          ...(next.explicitPaths.kbDir === true ? { kbDir: true } : {}),
          ...(typeof next.explicitPaths.kbUrl === "boolean"
            ? { kbUrl: next.explicitPaths.kbUrl }
            : {}),
        }
      : undefined;
  return {
    workspace,
    kbDir,
    agentDir,
    kbUrl,
    proxy: sanitizedProxy,
    confirmTimeoutSec: next.confirmTimeoutSec,
    telegramEnabled: Boolean(next.telegramEnabled),
    allowedUserIds,
    model: {
      provider: next.model.provider.trim(),
      id: next.model.id.trim(),
      thinking: next.model.thinking,
    },
    ...(explicitPaths !== undefined ? { explicitPaths } : {}),
  };
}

export class WagentRuntime {
  readonly #stateDir: string;
  readonly #homeDir: string;
  readonly #configPath: string;
  readonly #runsPath: string;
  readonly #env: Readonly<Record<string, string | undefined>> | undefined;
  readonly #uvBinary: string | undefined;
  readonly #getSecrets: () => Promise<WagentSecrets>;
  readonly #resolveExecutionContext:
    | (() => Promise<{ readonly config: WagentStoredConfig; readonly secrets: WagentSecrets }>)
    | undefined;
  readonly #executor: WagentExecutor;
  readonly #approvalTimeoutOverrideMs: number | undefined;
  readonly #wkbExportImpl: typeof runWkbExport;
  readonly #approvalHub = new ApprovalHub();
  readonly #listeners = new Set<(event: WagentBridgeEvent) => void>();
  readonly #queue: Array<QueuedTask> = [];

  #config: WagentStoredConfig;
  #persistedKbUrl: string | null = null;
  #unmigratedLegacyProxyUrl: string | null = null;
  #pendingConfigRewrite = false;
  #sessionId: string = NodeCrypto.randomUUID();
  #recentRuns: Array<WagentRunRecord> = [];
  #activeRun: WagentRunRecord | null = null;
  #activeAbort: AbortController | null = null;
  #processing = false;
  #unsubscribeApproval: () => void;

  constructor(options: WagentRuntimeOptions) {
    this.#stateDir = options.stateDir;
    this.#homeDir = options.homeDir;
    this.#configPath = NodePath.join(options.stateDir, "config.json");
    this.#runsPath = NodePath.join(options.stateDir, "runs.json");
    this.#env = options.env;
    this.#uvBinary = options.uvBinary;
    this.#getSecrets = options.getSecrets;
    this.#resolveExecutionContext = options.resolveExecutionContext;
    this.#executor = options.executor ?? createPiSubprocessExecutor();
    this.#approvalTimeoutOverrideMs = options.approvalTimeoutOverrideMs;
    this.#wkbExportImpl = options.wkbExportImpl ?? runWkbExport;
    this.#config = this.#loadConfig(
      defaultConfig({
        homeDir: options.homeDir,
        defaultKbDir: options.defaultKbDir,
        defaultAgentDir: options.defaultAgentDir,
      }),
    );
    this.#recentRuns = this.#loadRuns();
    this.#ensureWorkspaceDirsSync();
    this.#unsubscribeApproval = this.#approvalHub.subscribe((event) => {
      if (this.#activeRun && event.approval.runId === this.#activeRun.id) {
        if (event.type === "approval_requested") {
          this.#activeRun = {
            ...this.#activeRun,
            status: "awaiting_approval",
            updatedAt: new Date().toISOString(),
            steps: this.#appendStep(this.#activeRun.steps, {
              timestamp: new Date().toISOString(),
              kind: "approval",
              text: `等待删除确认：${event.approval.reason}`,
            }),
          };
        } else if (this.#activeRun.status === "awaiting_approval") {
          this.#activeRun = {
            ...this.#activeRun,
            status: "running",
            updatedAt: new Date().toISOString(),
            steps: this.#appendStep(this.#activeRun.steps, {
              timestamp: new Date().toISOString(),
              kind: "approval",
              text:
                event.approval.status === "approved"
                  ? `已允许删除：${event.approval.reason}`
                  : `已拒绝删除：${event.approval.reason} (${event.approval.status})`,
            }),
          };
        }
      }
      this.#emit(event);
    });
  }

  get approvalHub(): ApprovalHub {
    return this.#approvalHub;
  }

  get config(): WagentStoredConfig {
    return this.#config;
  }

  get inboxDir(): string {
    return NodePath.join(this.#config.workspace, "inbox");
  }

  get exportsDir(): string {
    return NodePath.join(this.#config.workspace, "exports");
  }

  get persistedKbUrl(): string | null {
    return this.#persistedKbUrl;
  }

  get unmigratedLegacyProxyUrl(): string | null {
    return this.#unmigratedLegacyProxyUrl;
  }

  consumeMigratedLegacyProxyUrl(): string | null {
    return this.#unmigratedLegacyProxyUrl;
  }

  async confirmLegacyProxyMigrated(): Promise<void> {
    await this.flushPendingConfigRewrite();
  }

  async flushPendingConfigRewrite(): Promise<void> {
    if (this.#pendingConfigRewrite) {
      await this.#writeConfigFile(this.#config);
      this.#pendingConfigRewrite = false;
    }
    this.#unmigratedLegacyProxyUrl = null;
  }

  validatePatch(patch: WagentConfigPatch): WagentStoredConfig {
    const normalizeComparableKbUrl = (raw: string): string => {
      const trimmed = raw.trim();
      if (!trimmed) return "";
      try {
        const parsed = new URL(trimmed);
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return trimmed;
      }
    };
    const agentDirChanged =
      patch.agentDir !== undefined && patch.agentDir.trim() !== this.#config.agentDir;
    const kbDirChanged = patch.kbDir !== undefined && patch.kbDir.trim() !== this.#config.kbDir;
    const kbUrlChanged =
      patch.kbUrl !== undefined &&
      normalizeComparableKbUrl(patch.kbUrl) !== normalizeComparableKbUrl(this.#config.kbUrl);

    const nextExplicitPaths = {
      ...this.#config.explicitPaths,
      ...(agentDirChanged ? { agentDir: true } : {}),
      ...(kbDirChanged ? { kbDir: true } : {}),
      ...(kbUrlChanged ? { kbUrl: true } : {}),
    };
    return validateConfig({
      ...this.#config,
      ...(patch.workspace !== undefined ? { workspace: patch.workspace } : {}),
      ...(patch.kbUrl !== undefined ? { kbUrl: patch.kbUrl } : {}),
      ...(patch.kbDir !== undefined ? { kbDir: patch.kbDir } : {}),
      ...(patch.confirmTimeoutSec !== undefined
        ? { confirmTimeoutSec: patch.confirmTimeoutSec }
        : {}),
      ...(patch.telegramEnabled !== undefined ? { telegramEnabled: patch.telegramEnabled } : {}),
      ...(patch.allowedUserIds !== undefined ? { allowedUserIds: patch.allowedUserIds } : {}),
      ...(patch.proxy !== undefined ? { proxy: patch.proxy } : {}),
      ...(patch.agentDir !== undefined ? { agentDir: patch.agentDir } : {}),
      explicitPaths: nextExplicitPaths,
      model: {
        ...this.#config.model,
        ...(patch.model?.provider !== undefined ? { provider: patch.model.provider } : {}),
        ...(patch.model?.id !== undefined ? { id: patch.model.id } : {}),
        ...(patch.model?.thinking !== undefined ? { thinking: patch.model.thinking } : {}),
      },
    });
  }

  async updateConfig(
    patch: WagentConfigPatch,
    options?: { readonly confirmLegacyProxyMigrated?: boolean | undefined },
  ): Promise<WagentStoredConfig> {
    if (
      this.#unmigratedLegacyProxyUrl !== null &&
      patch.proxy === undefined &&
      options?.confirmLegacyProxyMigrated !== true
    ) {
      throw new WagentBridgeError(
        "runtime_failed",
        "Cannot overwrite Wagent config before legacy proxy credentials are migrated to SecretStore.",
      );
    }
    const merged = this.validatePatch(patch);
    await this.#writeConfigFile(merged);
    this.#config = merged;
    if (patch.proxy !== undefined || options?.confirmLegacyProxyMigrated === true) {
      this.#unmigratedLegacyProxyUrl = null;
    }
    this.#pendingConfigRewrite = false;
    this.#ensureWorkspaceDirsSync();
    this.#emit({ type: "status_changed" });
    return this.#config;
  }

  subscribe(listener: (event: WagentBridgeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async getSnapshot(): Promise<WagentRuntimeSnapshot> {
    const exportsList = await this.listExports();
    return {
      running: this.#activeRun !== null,
      sessionId: this.#sessionId,
      activeRun: this.#activeRun,
      queuedRuns: this.#queue.map((item) => item.run),
      recentRuns: [...this.#recentRuns],
      pendingApprovals: this.#approvalHub.listPending(),
      exports: exportsList,
      config: this.#config,
      agentDirReady: NodeFS.existsSync(NodePath.join(this.#config.agentDir, "package.json")),
      kbDirReady: NodeFS.existsSync(NodePath.join(this.#config.kbDir, "pyproject.toml")),
    };
  }

  enqueue(input: {
    readonly prompt: string;
    readonly source: WagentDispatchSource;
    readonly onFile?: ((filePath: string, caption?: string) => Promise<void>) | undefined;
  }): { readonly run: WagentRunRecord; readonly completed: Promise<WagentRunRecord> } {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new WagentBridgeError("validation", "Prompt must not be empty.");
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw new WagentBridgeError(
        "validation",
        `Prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.`,
      );
    }

    const now = new Date().toISOString();
    const run: WagentRunRecord = {
      id: NodeCrypto.randomUUID(),
      prompt,
      source: input.source,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      output: "",
      error: null,
      steps: [],
    };

    let resolveFinished!: (completedRun: WagentRunRecord) => void;
    const completed = new Promise<WagentRunRecord>((resolve) => {
      resolveFinished = resolve;
    });

    this.#queue.push({
      run,
      onFile: input.onFile,
      resolveFinished,
    });
    this.#emit({ type: "status_changed" });
    void this.#drainQueue().catch(() => undefined);

    return { run, completed };
  }

  async abort(runId?: string): Promise<boolean> {
    if (runId) {
      const queuedIdx = this.#queue.findIndex((item) => item.run.id === runId);
      if (queuedIdx >= 0) {
        const [removed] = this.#queue.splice(queuedIdx, 1);
        if (removed) {
          const cancelled: WagentRunRecord = {
            ...removed.run,
            status: "cancelled",
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            error: "Cancelled before execution.",
          };
          this.#recordFinishedRun(cancelled);
          removed.resolveFinished(cancelled);
          this.#emit({ type: "run_finished", run: cancelled });
        }
        return true;
      }
      if (this.#activeRun && this.#activeRun.id !== runId) {
        return false;
      }
    }

    if (!this.#activeRun || !this.#activeAbort) {
      return false;
    }
    this.#approvalHub.cancelForRun(this.#activeRun.id);
    this.#activeAbort.abort();
    return true;
  }

  async newSession(): Promise<string> {
    if (this.#activeRun || this.#queue.length > 0) {
      throw new WagentBridgeError(
        "validation",
        "Cannot start a new Wagent session while a task is running or queued.",
      );
    }
    this.#sessionId = NodeCrypto.randomUUID();
    await this.#executor.resetSession?.(this.#sessionId);
    this.#emit({ type: "session_reset", sessionId: this.#sessionId });
    return this.#sessionId;
  }

  decideApproval(
    approvalId: string,
    allow: boolean,
    source: Exclude<WagentApprovalDecisionSource, "timeout" | "cancelled">,
  ): WagentPendingApproval {
    return this.#approvalHub.decide(approvalId, allow, source);
  }

  async listExports(): Promise<ReadonlyArray<WagentExportFile>> {
    const exportsRoot = this.exportsDir;
    if (!NodeFS.existsSync(exportsRoot)) return [];
    const realRoot = await NodeFSP.realpath(exportsRoot).catch(() => exportsRoot);
    const collected: Array<WagentExportFile> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3 || collected.length >= MAX_EXPORTS_LISTED) return;
      const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (collected.length >= MAX_EXPORTS_LISTED) break;
        if (entry.name.startsWith(".")) continue;
        const fullPath = NodePath.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await NodeFSP.stat(fullPath).catch(() => null);
        if (!stat) continue;
        const relativePath = NodePath.relative(realRoot, fullPath).split(NodePath.sep).join("/");
        collected.push({
          name: entry.name,
          relativePath,
          bytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
          kind: classifyExportKind(entry.name),
        });
      }
    };

    await walk(realRoot, 0);
    return collected.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async resolveExportFile(relativePath: string): Promise<{
    readonly absolutePath: string;
    readonly file: WagentExportFile;
  }> {
    const trimmed = relativePath.trim();
    if (!trimmed || trimmed.includes("\0") || NodePath.isAbsolute(trimmed)) {
      throw new WagentBridgeError("validation", "Export relativePath must be a relative path.");
    }
    const exportsRoot = this.exportsDir;
    await NodeFSP.mkdir(exportsRoot, { recursive: true });
    const realRoot = await NodeFSP.realpath(exportsRoot);
    const candidate = NodePath.resolve(realRoot, trimmed);
    const rel = NodePath.relative(realRoot, candidate);
    if (!rel || rel.startsWith("..") || NodePath.isAbsolute(rel)) {
      throw new WagentBridgeError("export_not_found", "Export path escapes workspace/exports.");
    }
    let realTarget: string;
    try {
      realTarget = await NodeFSP.realpath(candidate);
    } catch {
      throw new WagentBridgeError("export_not_found", `Export file '${trimmed}' does not exist.`);
    }
    const verifiedRel = NodePath.relative(realRoot, realTarget);
    if (!verifiedRel || verifiedRel.startsWith("..") || NodePath.isAbsolute(verifiedRel)) {
      throw new WagentBridgeError("export_not_found", "Export symlink escapes workspace/exports.");
    }
    const stat = await NodeFSP.stat(realTarget);
    if (!stat.isFile()) {
      throw new WagentBridgeError("export_not_found", `Export '${trimmed}' is not a regular file.`);
    }
    return {
      absolutePath: realTarget,
      file: {
        name: NodePath.basename(realTarget),
        relativePath: verifiedRel.split(NodePath.sep).join("/"),
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        kind: classifyExportKind(realTarget),
      },
    };
  }

  async convertToDoc(input: {
    readonly source: string;
    readonly pdf?: boolean | undefined;
  }): Promise<{
    readonly result: WkbExportResult;
    readonly savedFiles: ReadonlyArray<WagentExportFile>;
  }> {
    await NodeFSP.mkdir(this.exportsDir, { recursive: true });
    const exported = await this.#wkbExportImpl(
      {
        source: input.source,
        outDir: this.exportsDir,
        pdf: input.pdf,
      },
      {
        kbDir: this.#config.kbDir,
        uvBinary: this.#uvBinary,
        env: this.#env,
        allowedLocalRoots: [this.#config.workspace],
      },
    );

    const exportsRoot = await NodeFSP.realpath(this.exportsDir);
    const savedFiles: Array<WagentExportFile> = [];
    const registerIfInsideExports = async (candidatePath: string | null): Promise<void> => {
      if (!candidatePath || !NodeFS.existsSync(candidatePath)) return;
      const realCandidate = await NodeFSP.realpath(candidatePath).catch(() => null);
      if (!realCandidate) return;
      const rel = NodePath.relative(exportsRoot, realCandidate);
      if (!rel || rel.startsWith("..") || NodePath.isAbsolute(rel)) return;
      const resolved = await this.resolveExportFile(rel.split(NodePath.sep).join("/"));
      savedFiles.push(resolved.file);
    };

    await registerIfInsideExports(exported.markdownPath);
    await registerIfInsideExports(exported.pdfPath);

    if (savedFiles.length === 0) {
      const slug =
        (exported.title || "export")
          .replaceAll(/[^\w\-\u4e00-\u9fff]+/g, "_")
          .replaceAll(/^_+|_+$/g, "")
          .slice(0, 64) || "export";
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
      const mdName = `${stamp}_${slug}.md`;
      await NodeFSP.writeFile(NodePath.join(this.exportsDir, mdName), exported.markdown, "utf8");
      const mdResolved = await this.resolveExportFile(mdName);
      savedFiles.push(mdResolved.file);
    }

    this.#emit({ type: "status_changed" });
    return { result: exported, savedFiles };
  }

  async dispose(): Promise<void> {
    if (this.#activeAbort) {
      this.#activeAbort.abort();
    }
    while (this.#queue.length > 0) {
      const removed = this.#queue.shift();
      if (removed) {
        const cancelled: WagentRunRecord = {
          ...removed.run,
          status: "cancelled",
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: "Wagent runtime shutting down.",
        };
        removed.resolveFinished(cancelled);
      }
    }
    this.#unsubscribeApproval();
    this.#approvalHub.dispose();
    await this.#executor.dispose?.();
    this.#listeners.clear();
  }

  async #drainQueue(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#queue.length > 0) {
        const task = this.#queue.shift();
        if (!task) break;
        await this.#executeTask(task);
      }
    } finally {
      this.#processing = false;
    }
  }

  async #executeTask(task: QueuedTask): Promise<void> {
    const abortController = new AbortController();
    this.#activeAbort = abortController;
    const startedRun: WagentRunRecord = {
      ...task.run,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    this.#activeRun = startedRun;
    this.#emit({ type: "run_started", run: startedRun });

    let output = "";
    let failedMessage: string | null = null;

    try {
      const { config: runConfig, secrets } = this.#resolveExecutionContext
        ? await this.#resolveExecutionContext()
        : {
            config: this.#config,
            secrets:
              this.#unmigratedLegacyProxyUrl !== null
                ? { proxyUrl: this.#unmigratedLegacyProxyUrl, ...(await this.#getSecrets()) }
                : await this.#getSecrets(),
          };
      await this.#executor.run({
        runId: startedRun.id,
        sessionId: this.#sessionId,
        prompt: startedRun.prompt,
        source: startedRun.source,
        config: runConfig,
        secrets,
        stateDir: this.#stateDir,
        uvBinary: this.#uvBinary,
        signal: abortController.signal,
        callbacks: {
          onText: (chunk) => {
            output += chunk;
            if (this.#activeRun && this.#activeRun.id === startedRun.id) {
              this.#activeRun = {
                ...this.#activeRun,
                output,
                updatedAt: new Date().toISOString(),
              };
            }
          },
          onTool: (label) => {
            this.#pushRunStep(startedRun.id, {
              timestamp: new Date().toISOString(),
              kind: "tool",
              text: label,
            });
          },
          onError: (message) => {
            failedMessage = message;
            this.#pushRunStep(startedRun.id, {
              timestamp: new Date().toISOString(),
              kind: "error",
              text: message,
            });
          },
          requestApproval: async ({ reason, command }) => {
            const timeoutMs = this.#approvalTimeoutOverrideMs ?? runConfig.confirmTimeoutSec * 1000;
            const { decision } = this.#approvalHub.requestApproval({
              runId: startedRun.id,
              reason,
              command,
              timeoutMs,
            });
            return decision;
          },
          onSendFile: task.onFile,
        },
      });
    } catch (error) {
      if (error instanceof WagentBridgeError && error.code === "aborted") {
        failedMessage = null;
      } else {
        failedMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.#approvalHub.cancelForRun(startedRun.id);
    }

    const now = new Date().toISOString();
    const finalStatus: WagentRunRecord["status"] = abortController.signal.aborted
      ? "cancelled"
      : failedMessage
        ? "failed"
        : "completed";
    const finishedRun: WagentRunRecord = {
      ...(this.#activeRun ?? startedRun),
      status: finalStatus,
      output,
      error: finalStatus === "failed" ? failedMessage : null,
      updatedAt: now,
      completedAt: now,
    };

    this.#activeRun = null;
    this.#activeAbort = null;
    this.#recordFinishedRun(finishedRun);
    try {
      await this.#persistRuns();
    } catch {
      // Best-effort persistence: disk errors must never hang callers awaiting task completion.
    }
    this.#emit({ type: "run_finished", run: finishedRun });
    task.resolveFinished(finishedRun);
  }

  #pushRunStep(runId: string, step: WagentRunStep): void {
    if (!this.#activeRun || this.#activeRun.id !== runId) return;
    this.#activeRun = {
      ...this.#activeRun,
      updatedAt: step.timestamp,
      steps: this.#appendStep(this.#activeRun.steps, step),
    };
    this.#emit({ type: "run_step", runId, step });
  }

  #appendStep(
    steps: ReadonlyArray<WagentRunStep>,
    step: WagentRunStep,
  ): ReadonlyArray<WagentRunStep> {
    return [...steps.slice(-(MAX_RUN_STEPS - 1)), step];
  }

  #recordFinishedRun(run: WagentRunRecord): void {
    this.#recentRuns = [run, ...this.#recentRuns].slice(0, MAX_STORED_RUNS);
  }

  #ensureWorkspaceDirsSync(): void {
    for (const dir of [
      this.#stateDir,
      NodePath.join(this.#stateDir, "sessions"),
      this.#config.workspace,
      NodePath.join(this.#config.workspace, "downloads"),
      NodePath.join(this.#config.workspace, "inbox"),
      NodePath.join(this.#config.workspace, "exports"),
    ]) {
      try {
        NodeFS.mkdirSync(dir, { recursive: true });
      } catch {
        // Invalid workspace paths are surfaced on actual operations.
      }
    }
  }

  #loadConfig(fallback: WagentStoredConfig): WagentStoredConfig {
    try {
      if (!NodeFS.existsSync(this.#configPath)) return fallback;
      const raw = JSON.parse(
        NodeFS.readFileSync(this.#configPath, "utf8"),
      ) as Partial<WagentStoredConfig>;

      let needsRewrite = false;
      let agentDir = raw.agentDir ?? fallback.agentDir;
      if (typeof raw.agentDir === "string" && raw.explicitPaths?.agentDir !== true) {
        const canonicalAgent = canonicalizeTrustedAgentDir(
          raw.agentDir,
          this.#homeDir,
          fallback.agentDir,
        );
        if (canonicalAgent === null) {
          agentDir = fallback.agentDir;
          needsRewrite = true;
        } else {
          if (canonicalAgent !== raw.agentDir) needsRewrite = true;
          agentDir = canonicalAgent;
        }
      }

      let kbDir = raw.kbDir ?? fallback.kbDir;
      if (typeof raw.kbDir === "string" && raw.explicitPaths?.kbDir !== true) {
        const canonicalKb = canonicalizeTrustedKbDir(raw.kbDir, this.#homeDir, fallback.kbDir);
        if (canonicalKb === null) {
          kbDir = fallback.kbDir;
          needsRewrite = true;
        } else {
          if (canonicalKb !== raw.kbDir) needsRewrite = true;
          kbDir = canonicalKb;
        }
      }

      if (typeof raw.proxy === "string" && raw.proxy.trim().length > 0) {
        const parsedProxy = sanitizeProxyUrl(raw.proxy);
        if (parsedProxy.hasCredentials) {
          this.#unmigratedLegacyProxyUrl = raw.proxy.trim();
          needsRewrite = true;
        }
      }

      const hasExplicitKbUrl =
        typeof raw.kbUrl === "string" &&
        raw.kbUrl.trim().length > 0 &&
        raw.explicitPaths?.kbUrl !== false;

      const validated = validateConfig({
        ...fallback,
        ...raw,
        agentDir,
        kbDir,
        explicitPaths: {
          ...raw.explicitPaths,
          kbUrl: hasExplicitKbUrl,
        },
        model: {
          ...fallback.model,
          ...raw.model,
        },
      });

      this.#persistedKbUrl =
        hasExplicitKbUrl && validated.kbUrl.length > 0 ? validated.kbUrl : null;

      if (needsRewrite) {
        if (this.#unmigratedLegacyProxyUrl !== null) {
          // Defer rewriting config.json until SecretStore persists migrated proxy credentials.
          this.#pendingConfigRewrite = true;
        } else {
          try {
            NodeFS.mkdirSync(this.#stateDir, { recursive: true });
            NodeFS.writeFileSync(this.#configPath, `${JSON.stringify(validated, null, 2)}\n`, {
              encoding: "utf8",
              mode: 0o600,
            });
          } catch {
            this.#pendingConfigRewrite = true;
          }
        }
      }

      return validated;
    } catch {
      this.#persistedKbUrl = null;
      this.#unmigratedLegacyProxyUrl = null;
      return fallback;
    }
  }

  #loadRuns(): Array<WagentRunRecord> {
    try {
      if (!NodeFS.existsSync(this.#runsPath)) return [];
      const raw = JSON.parse(NodeFS.readFileSync(this.#runsPath, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return (raw as Array<WagentRunRecord>).slice(0, MAX_STORED_RUNS);
    } catch {
      return [];
    }
  }

  async #writeConfigFile(target: WagentStoredConfig): Promise<void> {
    await NodeFSP.mkdir(this.#stateDir, { recursive: true });
    const tmpPath = `${this.#configPath}.tmp.${process.pid}.${NodeCrypto.randomUUID()}`;
    try {
      await NodeFSP.writeFile(tmpPath, `${JSON.stringify(target, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await NodeFSP.rename(tmpPath, this.#configPath);
    } catch (error) {
      await NodeFSP.rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #persistRuns(): Promise<void> {
    await NodeFSP.mkdir(this.#stateDir, { recursive: true });
    await NodeFSP.writeFile(
      this.#runsPath,
      `${JSON.stringify(this.#recentRuns.slice(0, MAX_STORED_RUNS), null, 2)}\n`,
      "utf8",
    );
  }

  #emit(event: WagentBridgeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Never allow subscriber errors to break runtime execution.
      }
    }
  }
}

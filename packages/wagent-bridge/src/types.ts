export type WagentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type WagentDispatchSource = "ui" | "mcp" | "telegram";

export type WagentApprovalDecisionSource = "ui" | "telegram" | "timeout" | "cancelled";

export type WagentApprovalStatus = "pending" | "approved" | "denied" | "timed_out" | "cancelled";

export type WagentRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "cancelled"
  | "failed";

export interface WagentModelConfig {
  readonly provider: string;
  readonly id: string;
  readonly thinking: WagentThinkingLevel;
}

export interface WagentExplicitPaths {
  readonly agentDir?: boolean | undefined;
  readonly kbDir?: boolean | undefined;
  readonly kbUrl?: boolean | undefined;
}

export interface WagentStoredConfig {
  readonly workspace: string;
  readonly model: WagentModelConfig;
  readonly kbUrl: string;
  readonly kbDir: string;
  readonly confirmTimeoutSec: number;
  readonly telegramEnabled: boolean;
  readonly allowedUserIds: ReadonlyArray<number>;
  readonly proxy: string;
  readonly agentDir: string;
  readonly explicitPaths?: WagentExplicitPaths | undefined;
}

export interface WagentSecrets {
  readonly telegramBotToken?: string | undefined;
  readonly deepseekApiKey?: string | undefined;
  readonly wkbToken?: string | undefined;
  readonly proxyUrl?: string | undefined;
}

export interface WagentPendingApproval {
  readonly id: string;
  readonly runId: string;
  readonly reason: string;
  readonly command: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: WagentApprovalStatus;
  readonly decidedBy?: WagentApprovalDecisionSource | undefined;
  readonly decidedAt?: string | undefined;
}

export interface WagentRunStep {
  readonly timestamp: string;
  readonly kind: "tool" | "text" | "error" | "approval";
  readonly text: string;
}

export interface WagentRunRecord {
  readonly id: string;
  readonly prompt: string;
  readonly source: WagentDispatchSource;
  readonly status: WagentRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly output: string;
  readonly error: string | null;
  readonly steps: ReadonlyArray<WagentRunStep>;
}

export interface WagentExportFile {
  readonly name: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly updatedAt: string;
  readonly kind: "pdf" | "markdown" | "text" | "other";
}

export type WagentBridgeEvent =
  | { readonly type: "run_started"; readonly run: WagentRunRecord }
  | { readonly type: "run_step"; readonly runId: string; readonly step: WagentRunStep }
  | { readonly type: "run_finished"; readonly run: WagentRunRecord }
  | { readonly type: "approval_requested"; readonly approval: WagentPendingApproval }
  | { readonly type: "approval_resolved"; readonly approval: WagentPendingApproval }
  | { readonly type: "session_reset"; readonly sessionId: string }
  | { readonly type: "status_changed" };

export interface WagentExecutorCallbacks {
  readonly onText: (text: string) => void;
  readonly onTool: (label: string) => void;
  readonly onError: (message: string) => void;
  readonly requestApproval: (input: {
    readonly reason: string;
    readonly command: string;
  }) => Promise<boolean>;
  readonly onSendFile?: ((filePath: string, caption?: string) => Promise<void>) | undefined;
}

export interface WagentExecutorRunInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly source: WagentDispatchSource;
  readonly config: WagentStoredConfig;
  readonly secrets: WagentSecrets;
  readonly stateDir: string;
  readonly uvBinary?: string | undefined;
  readonly signal: AbortSignal;
  readonly callbacks: WagentExecutorCallbacks;
}

export interface WagentExecutor {
  readonly run: (input: WagentExecutorRunInput) => Promise<void>;
  readonly resetSession?: ((sessionId: string) => Promise<void>) | undefined;
  readonly dispose?: (() => Promise<void>) | undefined;
}

import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { LibraryEntry, LibraryEntryKind } from "./library.ts";

export const WagentThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type WagentThinkingLevel = typeof WagentThinkingLevel.Type;

export const WagentDispatchSource = Schema.Literals(["ui", "mcp", "telegram"]);
export type WagentDispatchSource = typeof WagentDispatchSource.Type;

export const WagentApprovalDecisionSource = Schema.Literals([
  "ui",
  "telegram",
  "timeout",
  "cancelled",
]);
export type WagentApprovalDecisionSource = typeof WagentApprovalDecisionSource.Type;

export const WagentApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "timed_out",
  "cancelled",
]);
export type WagentApprovalStatus = typeof WagentApprovalStatus.Type;

export const WagentRunStatus = Schema.Literals([
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "cancelled",
  "failed",
]);
export type WagentRunStatus = typeof WagentRunStatus.Type;

export const WagentExportKind = Schema.Literals(["pdf", "markdown", "text", "other"]);
export type WagentExportKind = typeof WagentExportKind.Type;

export const WagentModelConfig = Schema.Struct({
  provider: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  thinking: WagentThinkingLevel,
});
export type WagentModelConfig = typeof WagentModelConfig.Type;

export const WagentConfigView = Schema.Struct({
  workspace: Schema.String.check(Schema.isMaxLength(1024)),
  model: WagentModelConfig,
  kbUrl: Schema.String.check(Schema.isMaxLength(2048)),
  kbDir: Schema.String.check(Schema.isMaxLength(1024)),
  confirmTimeoutSec: Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
  telegramEnabled: Schema.Boolean,
  allowedUserIds: Schema.Array(Schema.Int),
  proxy: Schema.String.check(Schema.isMaxLength(1024)),
  agentDir: Schema.String.check(Schema.isMaxLength(1024)),
  hasTelegramBotToken: Schema.Boolean,
  hasDeepseekApiKey: Schema.Boolean,
  hasWkbToken: Schema.Boolean,
  hasProxyCredentials: Schema.optional(Schema.Boolean),
});
export type WagentConfigView = typeof WagentConfigView.Type;

export const WagentRunStep = Schema.Struct({
  timestamp: IsoDateTime,
  kind: Schema.Literals(["tool", "text", "error", "approval"]),
  text: Schema.String,
});
export type WagentRunStep = typeof WagentRunStep.Type;

export const WagentRunRecord = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  prompt: Schema.String,
  source: WagentDispatchSource,
  status: WagentRunStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
  steps: Schema.Array(WagentRunStep),
});
export type WagentRunRecord = typeof WagentRunRecord.Type;

export const WagentPendingApproval = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  runId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  reason: Schema.String,
  command: Schema.String,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  status: WagentApprovalStatus,
  decidedBy: Schema.optional(WagentApprovalDecisionSource),
  decidedAt: Schema.optional(IsoDateTime),
});
export type WagentPendingApproval = typeof WagentPendingApproval.Type;

export const WagentExportFile = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  bytes: NonNegativeInt,
  updatedAt: IsoDateTime,
  kind: WagentExportKind,
});
export type WagentExportFile = typeof WagentExportFile.Type;

export const WagentStatusResult = Schema.Struct({
  running: Schema.Boolean,
  sessionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  activeRun: Schema.NullOr(WagentRunRecord),
  queuedRuns: Schema.Array(WagentRunRecord),
  recentRuns: Schema.Array(WagentRunRecord),
  pendingApprovals: Schema.Array(WagentPendingApproval),
  exports: Schema.Array(WagentExportFile),
  config: WagentConfigView,
  telegramConnected: Schema.Boolean,
  agentDirReady: Schema.Boolean,
  kbDirReady: Schema.Boolean,
});
export type WagentStatusResult = typeof WagentStatusResult.Type;

export const WagentSendInput = Schema.Struct({
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
});
export type WagentSendInput = typeof WagentSendInput.Type;

export const WagentSendResult = Schema.Struct({
  run: WagentRunRecord,
});
export type WagentSendResult = typeof WagentSendResult.Type;

export const WagentAbortInput = Schema.Struct({
  runId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type WagentAbortInput = typeof WagentAbortInput.Type;

export const WagentAbortResult = Schema.Struct({
  aborted: Schema.Boolean,
});
export type WagentAbortResult = typeof WagentAbortResult.Type;

export const WagentNewSessionResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type WagentNewSessionResult = typeof WagentNewSessionResult.Type;

export const WagentDecideApprovalInput = Schema.Struct({
  approvalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  allow: Schema.Boolean,
});
export type WagentDecideApprovalInput = typeof WagentDecideApprovalInput.Type;

export const WagentDecideApprovalResult = Schema.Struct({
  approval: WagentPendingApproval,
});
export type WagentDecideApprovalResult = typeof WagentDecideApprovalResult.Type;

export const WagentImportExportToLibraryInput = Schema.Struct({
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  tags: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(32)),
  ),
});
export type WagentImportExportToLibraryInput = typeof WagentImportExportToLibraryInput.Type;

export const WagentImportExportToLibraryResult = Schema.Struct({
  entry: LibraryEntry,
  exportFile: WagentExportFile,
});
export type WagentImportExportToLibraryResult = typeof WagentImportExportToLibraryResult.Type;

export const WagentConvertToDocInput = Schema.Struct({
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  pdf: Schema.optional(Schema.Boolean),
});
export type WagentConvertToDocInput = typeof WagentConvertToDocInput.Type;

export const WagentConvertToDocResult = Schema.Struct({
  title: Schema.String,
  inferredKind: LibraryEntryKind,
  warnings: Schema.Array(Schema.String),
  savedFiles: Schema.Array(WagentExportFile),
});
export type WagentConvertToDocResult = typeof WagentConvertToDocResult.Type;

export const WagentUpdateConfigInput = Schema.Struct({
  workspace: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  model: Schema.optional(
    Schema.Struct({
      provider: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
      id: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
      thinking: Schema.optional(WagentThinkingLevel),
    }),
  ),
  kbUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  kbDir: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  confirmTimeoutSec: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 3600 })),
  ),
  telegramEnabled: Schema.optional(Schema.Boolean),
  allowedUserIds: Schema.optional(Schema.Array(Schema.Int).check(Schema.isMaxLength(64))),
  proxy: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  agentDir: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  telegramBotToken: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(512)))),
  deepseekApiKey: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(512)))),
  wkbToken: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(512)))),
  expectedKbUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
});
export type WagentUpdateConfigInput = typeof WagentUpdateConfigInput.Type;

export const WagentUpdateConfigResult = Schema.Struct({
  status: WagentStatusResult,
});
export type WagentUpdateConfigResult = typeof WagentUpdateConfigResult.Type;

export const WagentEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    status: WagentStatusResult,
  }),
  Schema.Struct({
    type: Schema.Literal("run_started"),
    run: WagentRunRecord,
  }),
  Schema.Struct({
    type: Schema.Literal("run_step"),
    runId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    step: WagentRunStep,
  }),
  Schema.Struct({
    type: Schema.Literal("run_finished"),
    run: WagentRunRecord,
  }),
  Schema.Struct({
    type: Schema.Literal("approval_requested"),
    approval: WagentPendingApproval,
  }),
  Schema.Struct({
    type: Schema.Literal("approval_resolved"),
    approval: WagentPendingApproval,
  }),
  Schema.Struct({
    type: Schema.Literal("session_reset"),
    sessionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    type: Schema.Literal("status_changed"),
    status: WagentStatusResult,
  }),
]);
export type WagentEvent = typeof WagentEvent.Type;

export class WagentValidationError extends Schema.TaggedError<WagentValidationError>()(
  "WagentValidationError",
  {
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class WagentUnavailableError extends Schema.TaggedError<WagentUnavailableError>()(
  "WagentUnavailableError",
  {
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class WagentApprovalNotFoundError extends Schema.TaggedError<WagentApprovalNotFoundError>()(
  "WagentApprovalNotFoundError",
  {
    approvalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  },
) {
  override get message(): string {
    return `Wagent deletion approval '${this.approvalId}' was not found or already resolved.`;
  }
}

export class WagentExportNotFoundError extends Schema.TaggedError<WagentExportNotFoundError>()(
  "WagentExportNotFoundError",
  {
    relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  },
) {
  override get message(): string {
    return `Wagent export file '${this.relativePath}' was not found.`;
  }
}

export class WagentRuntimeError extends Schema.TaggedError<WagentRuntimeError>()(
  "WagentRuntimeError",
  {
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const WagentRpcError = Schema.Union([
  WagentValidationError,
  WagentUnavailableError,
  WagentApprovalNotFoundError,
  WagentExportNotFoundError,
  WagentRuntimeError,
]);
export type WagentRpcError = typeof WagentRpcError.Type;

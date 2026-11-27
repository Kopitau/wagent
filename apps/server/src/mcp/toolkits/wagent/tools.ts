import {
  LibraryEntryKind,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
  WagentExportFile,
  WagentPendingApproval,
  WagentRunRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as WagentService from "../../../wagent/WagentService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    WagentService.WagentService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

const WagentMcpStatusResult = Schema.Struct({
  running: Schema.Boolean,
  sessionId: Schema.String,
  telegramConnected: Schema.Boolean,
  agentDirReady: Schema.Boolean,
  kbDirReady: Schema.Boolean,
  activeRun: Schema.NullOr(WagentRunRecord),
  queuedCount: Schema.Int,
  pendingApprovals: Schema.Array(WagentPendingApproval),
  recentExports: Schema.Array(WagentExportFile),
});

const WagentDispatchTool = Tool.make("wagent_dispatch", {
  ...shared,
  description:
    "Dispatch a personal digital-twin task to Wagent (separate from coding threads). Wagent runs in its own ~/Wagent workspace and pauses for explicit owner confirmation on any deletion command.",
  parameters: Schema.Struct({
    prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)).annotate({
      description: "Task instruction for Wagent to execute.",
    }),
    awaitCompletion: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Wait for the task to finish before returning (default false; returns queued run immediately).",
      }),
    ),
  }),
  success: Schema.Struct({
    run: WagentRunRecord,
  }),
})
  .annotate(Tool.Title, "Dispatch task to Wagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WagentStatusTool = Tool.make("wagent_status", {
  ...shared,
  description:
    "Inspect Wagent's current status, active/queued task runs, pending deletion approvals, and exported files.",
  parameters: Schema.Struct({
    includeExports: Schema.optional(
      Schema.Boolean.annotate({
        description: "Include recent workspace/exports files (default true).",
      }),
    ),
  }),
  success: WagentMcpStatusResult,
})
  .annotate(Tool.Title, "Inspect Wagent status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WagentCancelTool = Tool.make("wagent_cancel", {
  ...shared,
  description: "Cancel the currently running Wagent task or a specific queued Wagent run by ID.",
  parameters: Schema.Struct({
    runId: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
        description: "Optional run ID to cancel; omit to abort the active run.",
      }),
    ),
  }),
  success: Schema.Struct({
    aborted: Schema.Boolean,
  }),
})
  .annotate(Tool.Title, "Cancel Wagent task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WagentConvertToDocTool = Tool.make("wagent_convert_to_doc", {
  ...shared,
  description:
    "Convert a webpage, WeChat/Bilibili/YouTube URL, or local file into Markdown (and optional PDF) inside Wagent's workspace/exports directory via wkb.",
  parameters: Schema.Struct({
    source: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)).annotate({
      description: "URL or file path inside Wagent workspace to convert.",
    }),
    pdf: Schema.optional(
      Schema.Boolean.annotate({
        description: "Also export a PDF alongside Markdown.",
      }),
    ),
  }),
  success: Schema.Struct({
    title: Schema.String,
    inferredKind: LibraryEntryKind,
    warnings: Schema.Array(Schema.String),
    savedFiles: Schema.Array(WagentExportFile),
  }),
})
  .annotate(Tool.Title, "Convert source to Wagent doc")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const WagentToolkit = Toolkit.make(
  WagentDispatchTool,
  WagentStatusTool,
  WagentCancelTool,
  WagentConvertToDocTool,
);

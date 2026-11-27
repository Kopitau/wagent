import { OrchestratorMcpFailure, type WagentRpcError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as WagentService from "../../../wagent/WagentService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WagentToolkit } from "./tools.ts";

function toMcpFailure(error: WagentRpcError): OrchestratorMcpFailure {
  switch (error._tag) {
    case "WagentValidationError":
    case "WagentApprovalNotFoundError":
    case "WagentExportNotFoundError":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: error.message,
      });
    case "WagentUnavailableError":
      return new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: error.message,
      });
    case "WagentRuntimeError":
      return new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: error.message,
      });
  }
}

export const layer = McpToolAccess.toLayer(
  WagentToolkit,
  Effect.gen(function* () {
    const wagent = yield* WagentService.WagentService;

    return {
      wagent_dispatch: McpToolAccess.writes((input) =>
        wagent
          .send(
            { prompt: input.prompt },
            {
              source: "mcp",
              ...(input.awaitCompletion === undefined
                ? {}
                : { awaitCompletion: input.awaitCompletion }),
            },
          )
          .pipe(Effect.mapError(toMcpFailure)),
      ),
      wagent_status: McpToolAccess.reads((input) =>
        wagent.status.pipe(
          Effect.map((current) => ({
            running: current.running,
            sessionId: current.sessionId,
            telegramConnected: current.telegramConnected,
            agentDirReady: current.agentDirReady,
            kbDirReady: current.kbDirReady,
            activeRun: current.activeRun,
            queuedCount: current.queuedRuns.length,
            pendingApprovals: current.pendingApprovals,
            recentExports: input.includeExports === false ? [] : current.exports.slice(0, 20),
          })),
          Effect.mapError(toMcpFailure),
        ),
      ),
      wagent_cancel: McpToolAccess.writes((input) =>
        wagent
          .abort(input.runId === undefined ? {} : { runId: input.runId })
          .pipe(Effect.mapError(toMcpFailure)),
      ),
      wagent_convert_to_doc: McpToolAccess.writes((input) =>
        wagent
          .convertToDoc({
            source: input.source,
            ...(input.pdf === undefined ? {} : { pdf: input.pdf }),
          })
          .pipe(Effect.mapError(toMcpFailure)),
      ),
    };
  }),
);

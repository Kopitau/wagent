import type { WagentStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyWagentEvent } from "./wagent.ts";

const BASE_TS = "2026-01-01T00:00:00.000Z";

function sampleStatus(): WagentStatusResult {
  return {
    running: false,
    sessionId: "sess-1",
    activeRun: null,
    queuedRuns: [],
    recentRuns: [],
    pendingApprovals: [],
    exports: [],
    config: {
      workspace: "/tmp/Wagent",
      model: { provider: "deepseek", id: "deepseek-reasoner", thinking: "high" },
      kbUrl: "https://kb.example.invalid/kb/mcp",
      kbDir: "/tmp/kb",
      confirmTimeoutSec: 600,
      telegramEnabled: false,
      allowedUserIds: [],
      proxy: "",
      agentDir: "/tmp/agent",
      hasTelegramBotToken: false,
      hasDeepseekApiKey: false,
      hasWkbToken: false,
    },
    telegramConnected: false,
    agentDirReady: true,
    kbDirReady: true,
  };
}

describe("applyWagentEvent", () => {
  it("folds snapshot, run lifecycle, deletion approvals, and session resets deterministically", () => {
    let state = applyWagentEvent(null, { type: "snapshot", status: sampleStatus() });
    expect(state?.sessionId).toBe("sess-1");

    state = applyWagentEvent(state, {
      type: "run_started",
      run: {
        id: "run-1",
        prompt: "Clean temp",
        source: "ui",
        status: "running",
        createdAt: BASE_TS,
        updatedAt: BASE_TS,
        completedAt: null,
        output: "",
        error: null,
        steps: [],
      },
    });
    expect(state?.running).toBe(true);
    expect(state?.activeRun?.id).toBe("run-1");

    state = applyWagentEvent(state, {
      type: "run_step",
      runId: "run-1",
      step: { timestamp: BASE_TS, kind: "tool", text: "bash rm -rf tmp" },
    });
    expect(state?.activeRun?.steps).toHaveLength(1);

    state = applyWagentEvent(state, {
      type: "approval_requested",
      approval: {
        id: "appr-1",
        runId: "run-1",
        reason: "删除文件或目录",
        command: "rm -rf tmp",
        createdAt: BASE_TS,
        expiresAt: BASE_TS,
        status: "pending",
      },
    });
    expect(state?.pendingApprovals).toHaveLength(1);
    expect(state?.activeRun?.status).toBe("awaiting_approval");

    state = applyWagentEvent(state, {
      type: "approval_resolved",
      approval: {
        id: "appr-1",
        runId: "run-1",
        reason: "删除文件或目录",
        command: "rm -rf tmp",
        createdAt: BASE_TS,
        expiresAt: BASE_TS,
        status: "approved",
        decidedBy: "ui",
        decidedAt: BASE_TS,
      },
    });
    expect(state?.pendingApprovals).toHaveLength(0);
    expect(state?.activeRun?.status).toBe("running");

    state = applyWagentEvent(state, {
      type: "run_finished",
      run: {
        id: "run-1",
        prompt: "Clean temp",
        source: "ui",
        status: "completed",
        createdAt: BASE_TS,
        updatedAt: BASE_TS,
        completedAt: BASE_TS,
        output: "done",
        error: null,
        steps: [],
      },
    });
    expect(state?.running).toBe(false);
    expect(state?.activeRun).toBeNull();
    expect(state?.recentRuns[0]?.output).toBe("done");

    state = applyWagentEvent(state, { type: "session_reset", sessionId: "sess-2" });
    expect(state?.sessionId).toBe("sess-2");
  });
});

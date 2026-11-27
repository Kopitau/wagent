// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Pure non-Effect approval hub manages confirmation timers and timestamps directly.
import * as NodeCrypto from "node:crypto";

import { WagentBridgeError } from "./errors.ts";
import type { WagentApprovalDecisionSource, WagentPendingApproval } from "./types.ts";

export type ApprovalHubEvent =
  | { readonly type: "approval_requested"; readonly approval: WagentPendingApproval }
  | { readonly type: "approval_resolved"; readonly approval: WagentPendingApproval };

export type ApprovalHubListener = (event: ApprovalHubEvent) => void;

interface PendingEntry {
  approval: WagentPendingApproval;
  timer: ReturnType<typeof setTimeout>;
  resolve: (allowed: boolean) => void;
}

export interface RequestApprovalInput {
  readonly runId: string;
  readonly reason: string;
  readonly command: string;
  readonly timeoutMs: number;
}

export class ApprovalHub {
  readonly #pending = new Map<string, PendingEntry>();
  readonly #listeners = new Set<ApprovalHubListener>();

  subscribe(listener: ApprovalHubListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  listPending(): ReadonlyArray<WagentPendingApproval> {
    return [...this.#pending.values()]
      .map((entry) => entry.approval)
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getPending(id: string): WagentPendingApproval | null {
    return this.#pending.get(id)?.approval ?? null;
  }

  requestApproval(input: RequestApprovalInput): {
    readonly approval: WagentPendingApproval;
    readonly decision: Promise<boolean>;
  } {
    const id = NodeCrypto.randomUUID();
    const nowMs = Date.now();
    const timeoutMs = Math.max(50, Math.floor(input.timeoutMs));
    const approval: WagentPendingApproval = {
      id,
      runId: input.runId,
      reason: input.reason,
      command: input.command,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + timeoutMs).toISOString(),
      status: "pending",
    };

    let resolveDecision!: (allowed: boolean) => void;
    const decision = new Promise<boolean>((resolve) => {
      resolveDecision = resolve;
    });

    const timer = setTimeout(() => {
      this.#settle(id, false, "timeout", "timed_out");
    }, timeoutMs);
    timer.unref?.();

    this.#pending.set(id, {
      approval,
      timer,
      resolve: resolveDecision,
    });
    this.#emit({ type: "approval_requested", approval });

    return { approval, decision };
  }

  tryDecide(
    id: string,
    allow: boolean,
    source: Exclude<WagentApprovalDecisionSource, "timeout" | "cancelled">,
  ): WagentPendingApproval | null {
    return this.#settle(id, allow, source, allow ? "approved" : "denied");
  }

  decide(
    id: string,
    allow: boolean,
    source: Exclude<WagentApprovalDecisionSource, "timeout" | "cancelled">,
  ): WagentPendingApproval {
    const resolved = this.tryDecide(id, allow, source);
    if (!resolved) {
      throw new WagentBridgeError(
        "approval_not_found",
        `Deletion approval '${id}' is no longer pending.`,
      );
    }
    return resolved;
  }

  cancelForRun(runId: string): ReadonlyArray<WagentPendingApproval> {
    const cancelled: WagentPendingApproval[] = [];
    for (const [id, entry] of this.#pending) {
      if (entry.approval.runId !== runId) continue;
      const settled = this.#settle(id, false, "cancelled", "cancelled");
      if (settled) cancelled.push(settled);
    }
    return cancelled;
  }

  dispose(): void {
    for (const id of this.#pending.keys()) {
      this.#settle(id, false, "cancelled", "cancelled");
    }
    this.#listeners.clear();
  }

  #settle(
    id: string,
    allow: boolean,
    source: WagentApprovalDecisionSource,
    status: Exclude<WagentPendingApproval["status"], "pending">,
  ): WagentPendingApproval | null {
    const entry = this.#pending.get(id);
    if (!entry) return null;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    const resolved: WagentPendingApproval = {
      ...entry.approval,
      status,
      decidedBy: source,
      decidedAt: new Date().toISOString(),
    };
    entry.resolve(allow);
    this.#emit({ type: "approval_resolved", approval: resolved });
    return resolved;
  }

  #emit(event: ApprovalHubEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must never break approval resolution.
      }
    }
  }
}

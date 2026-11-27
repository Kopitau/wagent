import {
  type EnvironmentId,
  WS_METHODS,
  type WagentEvent,
  type WagentStatusResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Stream from "effect/Stream";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

const WAGENT_QUERY_IDLE_TTL_MS = 15_000;

export function applyWagentEvent(
  current: WagentStatusResult | null,
  event: WagentEvent,
): WagentStatusResult | null {
  switch (event.type) {
    case "snapshot":
    case "status_changed":
      return event.status;
    case "run_started":
      if (!current) return current;
      return {
        ...current,
        running: true,
        activeRun: event.run,
        queuedRuns: current.queuedRuns.filter((run) => run.id !== event.run.id),
      };
    case "run_step":
      if (!current || !current.activeRun || current.activeRun.id !== event.runId) return current;
      return {
        ...current,
        activeRun: {
          ...current.activeRun,
          updatedAt: event.step.timestamp,
          steps: [...current.activeRun.steps.slice(-79), event.step],
        },
      };
    case "run_finished":
      if (!current) return current;
      return {
        ...current,
        running: false,
        activeRun: current.activeRun?.id === event.run.id ? null : current.activeRun,
        queuedRuns: current.queuedRuns.filter((run) => run.id !== event.run.id),
        recentRuns: [event.run, ...current.recentRuns.filter((r) => r.id !== event.run.id)].slice(
          0,
          50,
        ),
      };
    case "approval_requested":
      if (!current) return current;
      return {
        ...current,
        pendingApprovals: [
          ...current.pendingApprovals.filter((item) => item.id !== event.approval.id),
          event.approval,
        ],
        activeRun:
          current.activeRun && current.activeRun.id === event.approval.runId
            ? { ...current.activeRun, status: "awaiting_approval" }
            : current.activeRun,
      };
    case "approval_resolved":
      if (!current) return current;
      return {
        ...current,
        pendingApprovals: current.pendingApprovals.filter((item) => item.id !== event.approval.id),
        activeRun:
          current.activeRun &&
          current.activeRun.id === event.approval.runId &&
          current.activeRun.status === "awaiting_approval"
            ? { ...current.activeRun, status: "running" }
            : current.activeRun,
      };
    case "session_reset":
      if (!current) return current;
      return {
        ...current,
        sessionId: event.sessionId,
      };
  }
}

export function createWagentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options?: {
    readonly onExportImported?: (
      registry: AtomRegistry.AtomRegistry,
      environmentId: EnvironmentId,
    ) => void;
  },
) {
  const revisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:wagent:revision:${environmentId}`)),
  );

  const bumpRevision = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    registry.update(revisionAtom(environmentId), (current) => current + 1);
  };

  const readPermissions = createCommandPermissions(runtime, WS_METHODS.subscribeWagentEvents);

  return {
    revisionAtom,
    invalidate: bumpRevision,
    readPermissionAtom: readPermissions.permissionAtom,
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:wagent:status",
      tag: WS_METHODS.wagentStatus,
      staleTimeMs: 0,
      idleTtlMs: WAGENT_QUERY_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId }) => revisionAtom(environmentId),
    }),
    liveStatus: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:wagent:events",
      tag: WS_METHODS.subscribeWagentEvents,
      idleTtlMs: WAGENT_QUERY_IDLE_TTL_MS,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(() => null as WagentStatusResult | null, applyWagentEvent),
          Stream.filter((value): value is WagentStatusResult => value !== null),
        ),
    }),
    refreshStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wagent:refresh-status",
      tag: WS_METHODS.wagentStatus,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wagent:send",
      tag: WS_METHODS.wagentSend,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    abort: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wagent:abort",
      tag: WS_METHODS.wagentAbort,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    newSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wagent:new-session",
      tag: WS_METHODS.wagentNewSession,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    decideApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wagent:decide-approval",
      tag: WS_METHODS.wagentDecideApproval,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    importExportToLibrary: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wagent:import-export-to-library",
      tag: WS_METHODS.wagentImportExportToLibrary,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
          options?.onExportImported?.(registry, environmentId);
        }),
    }),
    convertToDoc: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wagent:convert-to-doc",
      tag: WS_METHODS.wagentConvertToDoc,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    updateConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:wagent:update-config",
      tag: WS_METHODS.wagentUpdateConfig,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
  };
}

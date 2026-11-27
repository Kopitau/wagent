import {
  isLibraryEditConflictError,
  type EnvironmentId,
  type WagentStatusResult,
} from "@t3tools/contracts";

import type { EnvironmentPresentation } from "./environments";

export type MobileCapabilityTargetResolution =
  | {
      readonly kind: "ready";
      readonly environment: EnvironmentPresentation;
    }
  | {
      readonly kind: "unsupported";
      readonly environment: EnvironmentPresentation;
    }
  | {
      readonly kind: "disconnected";
      readonly environment: EnvironmentPresentation | null;
    };

function resolveMobileCapabilityTarget(
  environments: ReadonlyArray<EnvironmentPresentation>,
  preferredEnvironmentId: EnvironmentId | null,
  capability: "researchLibrary" | "wagent",
): MobileCapabilityTargetResolution {
  if (preferredEnvironmentId !== null) {
    const preferred =
      environments.find((entry) => entry.environmentId === preferredEnvironmentId) ?? null;
    if (!preferred) {
      return { kind: "disconnected", environment: null };
    }
    if (preferred.connection.phase !== "connected" || preferred.serverConfig === null) {
      return { kind: "disconnected", environment: preferred };
    }
    return preferred.serverConfig.environment.capabilities[capability] === true
      ? { kind: "ready", environment: preferred }
      : { kind: "unsupported", environment: preferred };
  }

  const connected = environments.filter(
    (entry) => entry.connection.phase === "connected" && entry.serverConfig !== null,
  );
  if (connected.length === 0) {
    return { kind: "disconnected", environment: environments[0] ?? null };
  }

  const supported = connected.find(
    (entry) => entry.serverConfig?.environment.capabilities[capability] === true,
  );
  if (supported) {
    return { kind: "ready", environment: supported };
  }

  return { kind: "unsupported", environment: connected[0]! };
}

export function resolveMobileLibraryTarget(
  environments: ReadonlyArray<EnvironmentPresentation>,
  preferredEnvironmentId: EnvironmentId | null,
): MobileCapabilityTargetResolution {
  return resolveMobileCapabilityTarget(environments, preferredEnvironmentId, "researchLibrary");
}

export function resolveMobileWagentTarget(
  environments: ReadonlyArray<EnvironmentPresentation>,
  preferredEnvironmentId: EnvironmentId | null,
): MobileCapabilityTargetResolution {
  return resolveMobileCapabilityTarget(environments, preferredEnvironmentId, "wagent");
}

export function isLibraryConflictFailure(error: unknown): boolean {
  if (isLibraryEditConflictError(error)) return true;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return (error as { readonly _tag?: unknown })._tag === "LibraryEditConflictError";
  }
  return false;
}

export function extractConflictCurrentRevision(error: unknown): number | null {
  if (
    isLibraryConflictFailure(error) &&
    typeof error === "object" &&
    error !== null &&
    "currentRevision" in error
  ) {
    const rev = (error as { readonly currentRevision?: unknown }).currentRevision;
    return typeof rev === "number" && Number.isInteger(rev) && rev > 0 ? rev : null;
  }
  return null;
}

export function mergeWagentStatus(
  liveStatus: WagentStatusResult | null,
  fallbackStatus: WagentStatusResult | null,
): WagentStatusResult | null {
  return liveStatus ?? fallbackStatus;
}

export function countPendingWagentApprovals(status: WagentStatusResult | null): number {
  return status?.pendingApprovals.length ?? 0;
}

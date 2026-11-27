import {
  EnvironmentId,
  LibraryEditConflictError,
  type WagentStatusResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentPresentation } from "./environments";
import {
  countPendingWagentApprovals,
  extractConflictCurrentRevision,
  isLibraryConflictFailure,
  mergeWagentStatus,
  resolveMobileLibraryTarget,
  resolveMobileWagentTarget,
} from "./libraryAndWagent.logic";

function makeEnvironment(input: {
  readonly id: string;
  readonly phase: "connected" | "connecting" | "offline";
  readonly researchLibrary?: boolean;
  readonly wagent?: boolean;
}): EnvironmentPresentation {
  return {
    environmentId: EnvironmentId.make(input.id),
    label: input.id,
    displayUrl: "https://example.invalid",
    relayManaged: false,
    connection: {
      phase: input.phase,
    },
    serverConfig:
      input.phase === "connected"
        ? {
            environment: {
              capabilities: {
                researchLibrary: input.researchLibrary ?? false,
                wagent: input.wagent ?? false,
              },
            },
          }
        : null,
  } as unknown as EnvironmentPresentation;
}

describe("mobile library and wagent state helpers", () => {
  it("resolves connected environments with researchLibrary capability before unsupported hosts", () => {
    const legacy = makeEnvironment({
      id: "env-legacy",
      phase: "connected",
      researchLibrary: false,
    });
    const supported = makeEnvironment({
      id: "env-lib",
      phase: "connected",
      researchLibrary: true,
    });
    const offline = makeEnvironment({ id: "env-offline", phase: "offline", researchLibrary: true });

    expect(resolveMobileLibraryTarget([offline], null)).toEqual({
      kind: "disconnected",
      environment: offline,
    });
    expect(resolveMobileLibraryTarget([legacy, supported], null)).toEqual({
      kind: "ready",
      environment: supported,
    });
    expect(resolveMobileLibraryTarget([legacy], null)).toEqual({
      kind: "unsupported",
      environment: legacy,
    });
    expect(resolveMobileLibraryTarget([legacy, supported], legacy.environmentId)).toEqual({
      kind: "unsupported",
      environment: legacy,
    });

    // When preferred environment disconnects while another host stays online, never silently switch targets!
    const disconnectedA = makeEnvironment({ id: "env-a", phase: "offline", researchLibrary: true });
    const connectedB = makeEnvironment({ id: "env-b", phase: "connected", researchLibrary: true });
    expect(
      resolveMobileLibraryTarget([disconnectedA, connectedB], disconnectedA.environmentId),
    ).toEqual({
      kind: "disconnected",
      environment: disconnectedA,
    });
    expect(
      resolveMobileWagentTarget([disconnectedA, connectedB], disconnectedA.environmentId),
    ).toEqual({
      kind: "disconnected",
      environment: disconnectedA,
    });
  });

  it("identifies LibraryEditConflictError and extracts currentRevision for conflict recovery", () => {
    const conflict = new LibraryEditConflictError({
      entryId: "entry-1",
      expectedRevision: 2,
      currentRevision: 5,
    });
    expect(isLibraryConflictFailure(conflict)).toBe(true);
    expect(extractConflictCurrentRevision(conflict)).toBe(5);
    expect(
      isLibraryConflictFailure({
        _tag: "LibraryEditConflictError",
        currentRevision: 7,
      }),
    ).toBe(true);
    expect(
      extractConflictCurrentRevision({
        _tag: "LibraryEditConflictError",
        currentRevision: 7,
      }),
    ).toBe(7);
    expect(isLibraryConflictFailure(new Error("network down"))).toBe(false);
    expect(extractConflictCurrentRevision(new Error("network down"))).toBeNull();
  });

  it("resolves Wagent target and merges live stream status over query fallback", () => {
    const hostA = makeEnvironment({ id: "env-a", phase: "connected", wagent: false });
    const hostB = makeEnvironment({ id: "env-b", phase: "connected", wagent: true });

    expect(resolveMobileWagentTarget([hostA, hostB], null)).toEqual({
      kind: "ready",
      environment: hostB,
    });
    expect(resolveMobileWagentTarget([], null)).toEqual({
      kind: "disconnected",
      environment: null,
    });

    const fallback = {
      running: false,
      pendingApprovals: [],
    } as unknown as WagentStatusResult;
    const live = {
      running: true,
      pendingApprovals: [{ id: "appr-1" }],
    } as unknown as WagentStatusResult;

    expect(mergeWagentStatus(null, fallback)).toBe(fallback);
    expect(mergeWagentStatus(live, fallback)).toBe(live);
    expect(countPendingWagentApprovals(live)).toBe(1);
    expect(countPendingWagentApprovals(null)).toBe(0);
  });
});

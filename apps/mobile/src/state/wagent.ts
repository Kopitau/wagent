import { useAtomValue } from "@effect/atom-react";
import { createWagentEnvironmentAtoms } from "@t3tools/client-runtime/state/wagent";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { libraryEnvironment } from "./library";
import {
  countPendingWagentApprovals,
  mergeWagentStatus,
  resolveMobileWagentTarget,
} from "./libraryAndWagent.logic";
import { useEnvironmentQuery } from "./query";

export { countPendingWagentApprovals, mergeWagentStatus, resolveMobileWagentTarget };

export const wagentEnvironment = createWagentEnvironmentAtoms(connectionAtomRuntime, {
  onExportImported: (registry, environmentId) => {
    libraryEnvironment.invalidate(registry, environmentId);
  },
});

const FALSE_PERMISSION_ATOM = Atom.make(false).pipe(
  Atom.withLabel("mobile-wagent:permission:false"),
);

export function useMobileWagentReadPermission(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId !== null
      ? wagentEnvironment.readPermissionAtom(environmentId)
      : FALSE_PERMISSION_ATOM,
  );
}

export function useMobileWagentWritePermission(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId !== null
      ? wagentEnvironment.send.permissionAtom(environmentId)
      : FALSE_PERMISSION_ATOM,
  );
}

export function useMobileWagentStatus(environmentId: EnvironmentId | null, enabled: boolean) {
  return useEnvironmentQuery(
    enabled && environmentId !== null
      ? wagentEnvironment.status({ environmentId, input: undefined })
      : null,
  );
}

export function useMobileWagentLiveStatus(environmentId: EnvironmentId | null, enabled: boolean) {
  return useEnvironmentQuery(
    enabled && environmentId !== null
      ? wagentEnvironment.liveStatus({ environmentId, input: undefined })
      : null,
  );
}

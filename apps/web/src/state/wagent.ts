import { useAtomValue } from "@effect/atom-react";
import { createWagentEnvironmentAtoms } from "@t3tools/client-runtime/state/wagent";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { libraryEnvironment } from "./library";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";

export const wagentEnvironment = createWagentEnvironmentAtoms(connectionAtomRuntime, {
  onExportImported: (registry, environmentId) => {
    libraryEnvironment.invalidate(registry, environmentId);
  },
});

const anyWagentReadableAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  for (const [environmentId, presentation] of presentations.entries()) {
    if (
      presentation.serverConfig?.environment.capabilities.wagent === true &&
      get(wagentEnvironment.readPermissionAtom(environmentId))
    ) {
      return true;
    }
  }
  return false;
}).pipe(Atom.withLabel("web-wagent:any-readable"));

export function useAnyWagentReadable(): boolean {
  return useAtomValue(anyWagentReadableAtom);
}

export function useWagentStatus(environmentId: EnvironmentId | null, enabled: boolean) {
  return useEnvironmentQuery(
    enabled && environmentId !== null
      ? wagentEnvironment.status({ environmentId, input: undefined })
      : null,
  );
}

export function useWagentLiveStatus(environmentId: EnvironmentId | null, enabled: boolean) {
  return useEnvironmentQuery(
    enabled && environmentId !== null
      ? wagentEnvironment.liveStatus({ environmentId, input: undefined })
      : null,
  );
}

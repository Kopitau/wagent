import { useAtomValue } from "@effect/atom-react";
import { createLibraryEnvironmentAtoms } from "@t3tools/client-runtime/state/library";
import type { EnvironmentId, LibraryListInput } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";

export const libraryEnvironment = createLibraryEnvironmentAtoms(connectionAtomRuntime);

const anyLibraryReadableAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  for (const [environmentId, presentation] of presentations.entries()) {
    if (
      presentation.serverConfig?.environment.capabilities.researchLibrary === true &&
      get(libraryEnvironment.composeDraft.permissionAtom(environmentId))
    ) {
      return true;
    }
  }
  return false;
}).pipe(Atom.withLabel("web-library:any-readable"));

export function useAnyLibraryReadable(): boolean {
  return useAtomValue(anyLibraryReadableAtom);
}

export function useLibraryList(
  environmentId: EnvironmentId | null,
  input: LibraryListInput,
  enabled: boolean,
) {
  return useEnvironmentQuery(
    enabled && environmentId !== null ? libraryEnvironment.list({ environmentId, input }) : null,
  );
}

export function useLibraryEntry(
  environmentId: EnvironmentId | null,
  entryId: string | null,
  enabled: boolean,
) {
  return useEnvironmentQuery(
    enabled && environmentId !== null && entryId !== null
      ? libraryEnvironment.get({ environmentId, input: { id: entryId } })
      : null,
  );
}

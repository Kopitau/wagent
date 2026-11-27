import { useAtomValue } from "@effect/atom-react";
import { createLibraryEnvironmentAtoms } from "@t3tools/client-runtime/state/library";
import type { EnvironmentId, LibraryListInput } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  extractConflictCurrentRevision,
  isLibraryConflictFailure,
  resolveMobileLibraryTarget,
} from "./libraryAndWagent.logic";
import { useEnvironmentQuery } from "./query";

export { extractConflictCurrentRevision, isLibraryConflictFailure, resolveMobileLibraryTarget };

export const libraryEnvironment = createLibraryEnvironmentAtoms(connectionAtomRuntime);

const FALSE_PERMISSION_ATOM = Atom.make(false).pipe(
  Atom.withLabel("mobile-library:permission:false"),
);

export function useMobileLibraryWritePermission(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId !== null
      ? libraryEnvironment.save.permissionAtom(environmentId)
      : FALSE_PERMISSION_ATOM,
  );
}

export function useMobileLibraryList(
  environmentId: EnvironmentId | null,
  input: LibraryListInput,
  enabled: boolean,
) {
  return useEnvironmentQuery(
    enabled && environmentId !== null ? libraryEnvironment.list({ environmentId, input }) : null,
  );
}

const MOBILE_MAX_ENTRY_BODY_CHARS = 4_500;

export function useMobileLibraryEntry(
  environmentId: EnvironmentId | null,
  entryId: string | null,
  enabled: boolean,
) {
  return useEnvironmentQuery(
    enabled && environmentId !== null && entryId !== null
      ? libraryEnvironment.get({
          environmentId,
          input: { id: entryId, maxBodyChars: MOBILE_MAX_ENTRY_BODY_CHARS },
        })
      : null,
  );
}

export function useMobileLibraryReadingState(
  environmentId: EnvironmentId | null,
  entryId: string | null,
  enabled: boolean,
) {
  return useEnvironmentQuery(
    enabled && environmentId !== null && entryId !== null
      ? libraryEnvironment.readingState({
          environmentId,
          input: { entryId, includePages: false },
        })
      : null,
  );
}

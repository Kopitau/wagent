import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const LIBRARY_QUERY_IDLE_TTL_MS = 15_000;

export function createLibraryEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const revisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:library:revision:${environmentId}`)),
  );

  const bumpRevision = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    registry.update(revisionAtom(environmentId), (current) => current + 1);
  };

  return {
    revisionAtom,
    invalidate: bumpRevision,
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:library:list",
      tag: WS_METHODS.libraryList,
      staleTimeMs: 0,
      idleTtlMs: LIBRARY_QUERY_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId }) => revisionAtom(environmentId),
    }),
    get: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:library:get",
      tag: WS_METHODS.libraryGet,
      staleTimeMs: 0,
      idleTtlMs: LIBRARY_QUERY_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId }) => revisionAtom(environmentId),
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:save",
      tag: WS_METHODS.librarySave,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    importTextFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:import-text-file",
      tag: WS_METHODS.libraryImportTextFile,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:update",
      tag: WS_METHODS.libraryUpdate,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:delete",
      tag: WS_METHODS.libraryDelete,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    composeDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:compose-draft",
      tag: WS_METHODS.libraryComposeDraft,
    }),
  };
}

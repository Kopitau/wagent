import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  fetchEnvironmentLibraryPdfBytes,
  uploadEnvironmentLibraryPdf,
  type FetchLibraryPdfBytesInput,
  type UploadLibraryPdfInput,
} from "./libraryHttp.ts";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

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
    wkbStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:library:wkb-status",
      tag: WS_METHODS.libraryWkbStatus,
      staleTimeMs: 30_000,
      idleTtlMs: LIBRARY_QUERY_IDLE_TTL_MS,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:save",
      tag: WS_METHODS.librarySave,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    fetchUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:fetch-url",
      tag: WS_METHODS.libraryFetchUrl,
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
    importFromWkb: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:import-from-wkb",
      tag: WS_METHODS.libraryImportFromWkb,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpRevision(registry, environmentId);
        }),
    }),
    uploadPdf: createEnvironmentCommand(runtime, {
      label: "environment-data:library:upload-pdf",
      execute: (input: UploadLibraryPdfInput, registry, environmentId) =>
        uploadEnvironmentLibraryPdf(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              bumpRevision(registry, environmentId);
            }),
          ),
        ),
    }),
    loadPdfBytes: createEnvironmentCommand(runtime, {
      label: "environment-data:library:load-pdf-bytes",
      execute: (input: FetchLibraryPdfBytesInput) => fetchEnvironmentLibraryPdfBytes(input),
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

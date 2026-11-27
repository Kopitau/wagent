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
  const readingRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:library:reading-revision:${environmentId}`)),
  );
  const imaRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:library:ima-revision:${environmentId}`)),
  );
  const feedRevisionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:library:feed-revision:${environmentId}`)),
  );

  const bumpRevision = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    registry.update(revisionAtom(environmentId), (current) => current + 1);
  };
  const bumpReadingRevision = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) => {
    registry.update(readingRevisionAtom(environmentId), (current) => current + 1);
  };
  const bumpImaRevision = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    registry.update(imaRevisionAtom(environmentId), (current) => current + 1);
  };
  const bumpFeedRevision = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    registry.update(feedRevisionAtom(environmentId), (current) => current + 1);
  };

  return {
    revisionAtom,
    readingRevisionAtom,
    imaRevisionAtom,
    feedRevisionAtom,
    invalidate: bumpRevision,
    invalidateReading: bumpReadingRevision,
    invalidateFeeds: bumpFeedRevision,
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
    readingState: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:library:reading-state",
      tag: WS_METHODS.libraryGetReadingState,
      staleTimeMs: 0,
      idleTtlMs: LIBRARY_QUERY_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId }) => readingRevisionAtom(environmentId),
    }),
    readingModels: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:library:reading-models",
      tag: WS_METHODS.libraryListReadingModels,
      staleTimeMs: 30_000,
      idleTtlMs: LIBRARY_QUERY_IDLE_TTL_MS,
    }),
    imaStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:library:ima-status",
      tag: WS_METHODS.libraryImaStatus,
      staleTimeMs: 15_000,
      idleTtlMs: LIBRARY_QUERY_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId }) => imaRevisionAtom(environmentId),
    }),
    setReadingPosition: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:set-reading-position",
      tag: WS_METHODS.librarySetReadingPosition,
    }),
    upsertReadingParagraph: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:upsert-reading-paragraph",
      tag: WS_METHODS.libraryUpsertReadingParagraph,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpReadingRevision(registry, environmentId);
        }),
    }),
    upsertReadingQuestion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:upsert-reading-question",
      tag: WS_METHODS.libraryUpsertReadingQuestion,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpReadingRevision(registry, environmentId);
        }),
    }),
    deleteReadingQuestion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:delete-reading-question",
      tag: WS_METHODS.libraryDeleteReadingQuestion,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpReadingRevision(registry, environmentId);
        }),
    }),
    upsertReadingInsight: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:upsert-reading-insight",
      tag: WS_METHODS.libraryUpsertReadingInsight,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpReadingRevision(registry, environmentId);
        }),
    }),
    setReadingPreference: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:set-reading-preference",
      tag: WS_METHODS.librarySetReadingPreference,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpReadingRevision(registry, environmentId);
        }),
    }),
    runReadingAiAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:run-reading-ai-action",
      tag: WS_METHODS.libraryRunReadingAiAction,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpReadingRevision(registry, environmentId);
        }),
    }),
    importGuide: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:import-guide",
      tag: WS_METHODS.libraryImportGuide,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpReadingRevision(registry, environmentId);
        }),
    }),
    syncWkbAnnotations: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:sync-wkb-annotations",
      tag: WS_METHODS.librarySyncWkbAnnotations,
    }),
    submitToWkb: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:submit-to-wkb",
      tag: WS_METHODS.librarySubmitToWkb,
    }),
    updateImaConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:update-ima-config",
      tag: WS_METHODS.libraryUpdateImaConfig,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpImaRevision(registry, environmentId);
        }),
    }),
    imaSearch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:ima-search",
      tag: WS_METHODS.libraryImaSearch,
    }),
    listFeeds: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:library:list-feeds",
      tag: WS_METHODS.libraryListFeeds,
      staleTimeMs: 0,
      idleTtlMs: LIBRARY_QUERY_IDLE_TTL_MS,
      refreshTrigger: ({ environmentId }) => feedRevisionAtom(environmentId),
    }),
    upsertFeed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:upsert-feed",
      tag: WS_METHODS.libraryUpsertFeed,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpFeedRevision(registry, environmentId);
        }),
    }),
    setFeedEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:set-feed-enabled",
      tag: WS_METHODS.librarySetFeedEnabled,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpFeedRevision(registry, environmentId);
        }),
    }),
    deleteFeed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:delete-feed",
      tag: WS_METHODS.libraryDeleteFeed,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpFeedRevision(registry, environmentId);
        }),
    }),
    runFeedNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:run-feed-now",
      tag: WS_METHODS.libraryRunFeedNow,
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          bumpFeedRevision(registry, environmentId);
          bumpRevision(registry, environmentId);
        }),
    }),
    runWorkHarvest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:library:run-work-harvest",
      tag: WS_METHODS.libraryRunWorkHarvest,
    }),
  };
}

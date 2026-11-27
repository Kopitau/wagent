import {
  type LibraryComposeDraftInput,
  type LibraryComposeDraftResult,
  type LibraryDeleteInput,
  type LibraryDeleteResult,
  LibraryDuplicateUrlError,
  LibraryEditConflictError,
  type LibraryEntry,
  type LibraryFetchUrlInput,
  type LibraryFetchUrlResult,
  type LibraryGetInput,
  type LibraryGetResult,
  type LibraryImportFromWkbInput,
  type LibraryImportFromWkbResult,
  type LibraryImportTextFileInput,
  type LibraryListInput,
  type LibraryListResult,
  LibraryNotFoundError,
  type LibraryRpcError,
  type LibrarySaveInput,
  LibrarySsrfRejectedError,
  LibraryStorageError,
  type LibraryUpdateInput,
  LibraryUploadTooLargeError,
  LibraryValidationError,
  LibraryWkbError,
  type LibraryWkbStatusResult,
} from "@t3tools/contracts";
import {
  LIBRARY_DEFAULT_BLOB_GC_GRACE_MS,
  LIBRARY_MAX_BODY_CHARS,
  LIBRARY_MAX_PDF_UPLOAD_BYTES,
  LIBRARY_MAX_TITLE_CHARS,
  LibraryDuplicateUrlError as DomainDuplicateUrlError,
  LibraryEditConflictError as DomainEditConflictError,
  LibraryNotFoundError as DomainNotFoundError,
  LibraryPdfExtractionError as DomainPdfExtractionError,
  LibrarySsrfRejectedError as DomainSsrfRejectedError,
  LibraryUploadTooLargeError as DomainUploadTooLargeError,
  LibraryValidationError as DomainValidationError,
  normalizeLibraryUrl,
  type LibraryBlobGcReport,
  type LibraryMcpReadItemInput,
  type LibraryMcpReadItemResult,
} from "@t3tools/research-library";
import {
  blobExistsOnDisk,
  cleanupStagedBlob,
  fetchWebArticle,
  inferWebEntryKind,
  openLibraryDatabase,
  publishStagedPdfBlob,
  recoverAndSweepBlobs,
  resolveBlobPath,
  stagePdfBlobFromFile,
  stagePdfBlobFromStream,
  type StagedPdfBlob,
} from "@t3tools/research-library/server";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WkbBridgeService from "../wkb/WkbBridgeService.ts";
import { extractPdfInIsolatedProcess } from "./LibraryPdfExtractor.ts";

class WebFetchAttemptError extends Schema.TaggedError<WebFetchAttemptError>()(
  "WebFetchAttemptError",
  { cause: Schema.Defect() },
) {}

export interface LibraryUploadPdfStreamInput {
  readonly fileName: string;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly title?: string | undefined;
  readonly note?: string | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly maxBytes?: number | undefined;
}

export type LibraryResolvedPdfBlob =
  | {
      readonly _tag: "Ready";
      readonly entry: LibraryEntry;
      readonly filePath: string;
      readonly bytes: number;
    }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "BlobMissing"; readonly entry: LibraryEntry };

function mapLibraryError(operation: string, cause: unknown): LibraryRpcError {
  if (cause instanceof DomainValidationError) {
    return new LibraryValidationError({
      field: cause.field.slice(0, 64) || "input",
      reason: cause.message.slice(0, 240) || "Invalid input.",
    });
  }
  if (cause instanceof DomainNotFoundError) {
    return new LibraryNotFoundError({ entryId: cause.entryId });
  }
  if (cause instanceof DomainDuplicateUrlError) {
    return new LibraryDuplicateUrlError({ existingEntryId: cause.existingEntryId });
  }
  if (cause instanceof DomainEditConflictError) {
    return new LibraryEditConflictError({
      entryId: cause.entryId,
      expectedRevision: cause.expectedRevision,
      currentRevision: cause.currentRevision,
    });
  }
  if (cause instanceof DomainSsrfRejectedError) {
    return new LibrarySsrfRejectedError({
      host: cause.host.slice(0, 255),
      reason: cause.message.slice(0, 240) || "Refused to fetch non-public host.",
    });
  }
  if (cause instanceof DomainUploadTooLargeError) {
    return new LibraryUploadTooLargeError({
      maxBytes: cause.maxBytes,
      receivedBytes: cause.receivedBytes,
    });
  }
  if (cause instanceof DomainPdfExtractionError) {
    return new LibraryValidationError({
      field: "file",
      reason: cause.message.slice(0, 240) || "Unable to extract text from PDF.",
    });
  }
  return new LibraryStorageError({ operation, cause });
}

function derivePdfTitle(
  explicitTitle: string | undefined,
  extractedTitle: string | null,
  fileName: string,
): string {
  const trimmedExplicit = explicitTitle?.trim();
  if (trimmedExplicit) return trimmedExplicit.slice(0, LIBRARY_MAX_TITLE_CHARS);
  const trimmedExtracted = extractedTitle?.trim();
  if (trimmedExtracted) return trimmedExtracted.slice(0, LIBRARY_MAX_TITLE_CHARS);
  const baseName = fileName.trim().split(/[\\/]/u).pop() ?? "";
  const withoutExt = baseName.replace(/\.pdf$/iu, "").trim();
  return (withoutExt || "Untitled PDF").slice(0, LIBRARY_MAX_TITLE_CHARS);
}

export class LibraryService extends Context.Service<
  LibraryService,
  {
    readonly list: (input: LibraryListInput) => Effect.Effect<LibraryListResult, LibraryRpcError>;
    readonly get: (input: LibraryGetInput) => Effect.Effect<LibraryGetResult, LibraryRpcError>;
    readonly save: (input: LibrarySaveInput) => Effect.Effect<LibraryEntry, LibraryRpcError>;
    readonly importTextFile: (
      input: LibraryImportTextFileInput,
    ) => Effect.Effect<LibraryEntry, LibraryRpcError>;
    readonly update: (input: LibraryUpdateInput) => Effect.Effect<LibraryEntry, LibraryRpcError>;
    readonly delete: (
      input: LibraryDeleteInput,
    ) => Effect.Effect<LibraryDeleteResult, LibraryRpcError>;
    readonly composeDraft: (
      input: LibraryComposeDraftInput,
    ) => Effect.Effect<LibraryComposeDraftResult, LibraryRpcError>;
    readonly uploadPdfStream: (
      input: LibraryUploadPdfStreamInput,
    ) => Effect.Effect<LibraryEntry, LibraryRpcError>;
    readonly resolvePdfBlob: (id: string) => Effect.Effect<LibraryResolvedPdfBlob, LibraryRpcError>;
    readonly fetchUrl: (
      input: LibraryFetchUrlInput,
    ) => Effect.Effect<LibraryFetchUrlResult, LibraryRpcError>;
    readonly wkbStatus: () => Effect.Effect<LibraryWkbStatusResult, LibraryRpcError>;
    readonly importFromWkb: (
      input: LibraryImportFromWkbInput,
    ) => Effect.Effect<LibraryImportFromWkbResult, LibraryRpcError>;
    readonly readItemForMcp: (
      input: LibraryMcpReadItemInput,
    ) => Effect.Effect<LibraryMcpReadItemResult, LibraryRpcError>;
    readonly runBlobGc: (options?: {
      readonly orphanGraceMs?: number | undefined;
      readonly tempGraceMs?: number | undefined;
      readonly unlinkFn?: ((filePath: string) => Promise<void>) | undefined;
    }) => Effect.Effect<LibraryBlobGcReport, LibraryRpcError>;
  }
>()("t3/library/LibraryService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const wkbService = yield* Effect.serviceOption(WkbBridgeService.WkbBridgeService);
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const platform = yield* HostProcess.Platform;
  const isWindows = platform === "win32";
  const libraryDir = path.join(config.stateDir, "research-library");
  const dbPath = path.join(libraryDir, "library.sqlite");
  const blobsDir = path.join(libraryDir, "blobs");

  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => openLibraryDatabase({ dbPath, isWindows }),
      catch: (cause) => new LibraryStorageError({ operation: "open", cause }),
    }),
    (opened) =>
      Effect.sync(() => {
        opened.close();
      }),
  );

  // Per-environment write coordinator shared by DB writes, blob publication, and delayed GC.
  const lock = yield* Semaphore.make(1);

  const enrichEntry = (entry: LibraryEntry): LibraryEntry => {
    if (entry.blobSha256 === null) return entry;
    return {
      ...entry,
      blobMissing: !blobExistsOnDisk(blobsDir, entry.blobSha256),
    };
  };

  const run = <A>(operation: string, fn: () => A): Effect.Effect<A, LibraryRpcError> =>
    lock.withPermits(1)(
      Effect.try({
        try: fn,
        catch: (cause) => mapLibraryError(operation, cause),
      }),
    );

  const runBlobGcLocked = Effect.fn("LibraryService.runBlobGcLocked")(function* (options?: {
    readonly orphanGraceMs?: number | undefined;
    readonly tempGraceMs?: number | undefined;
    readonly unlinkFn?: ((filePath: string) => Promise<void>) | undefined;
  }): Effect.fn.Return<LibraryBlobGcReport, LibraryRpcError> {
    const nowMs = yield* clock.currentTimeMillis;
    const referenced = database.listReferencedBlobSha256s();
    return yield* Effect.tryPromise({
      try: () =>
        recoverAndSweepBlobs({
          blobsDir,
          referencedSha256s: referenced,
          countBlobReferences: (sha256) => database.countBlobReferences(sha256),
          nowMs,
          orphanGraceMs: options?.orphanGraceMs ?? LIBRARY_DEFAULT_BLOB_GC_GRACE_MS,
          tempGraceMs: options?.tempGraceMs ?? LIBRARY_DEFAULT_BLOB_GC_GRACE_MS,
          unlinkFn: options?.unlinkFn,
        }),
      catch: (cause) => mapLibraryError("blobGc", cause),
    });
  });

  // Startup recovery: clean leftover .tmp-* immediately, sweep expired orphans, report missing blobs.
  const startupReport = yield* lock
    .withPermits(1)(runBlobGcLocked({ tempGraceMs: 0 }))
    .pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Research library startup blob recovery failed.", { cause }),
      ),
      Effect.orElseSucceed((): LibraryBlobGcReport => ({
        removedTempFiles: 0,
        removedOrphanBlobs: 0,
        deferredLockedBlobs: 0,
        missingBlobSha256s: [],
      })),
    );
  if (
    startupReport.removedTempFiles > 0 ||
    startupReport.removedOrphanBlobs > 0 ||
    startupReport.missingBlobSha256s.length > 0
  ) {
    yield* Effect.logInfo("Research library startup recovery completed.", {
      removedTempFiles: startupReport.removedTempFiles,
      removedOrphanBlobs: startupReport.removedOrphanBlobs,
      deferredLockedBlobs: startupReport.deferredLockedBlobs,
      missingBlobs: startupReport.missingBlobSha256s.length,
    });
  }

  const extractPdf = (pdfFilePath: string) =>
    extractPdfInIsolatedProcess(pdfFilePath).pipe(
      Effect.mapError((error) =>
        error.rejected
          ? new LibraryValidationError({
              field: "file",
              reason: error.message.slice(0, 240),
            })
          : new LibraryStorageError({ operation: "extractPdf", cause: error }),
      ),
    );

  const list: LibraryService["Service"]["list"] = Effect.fn("LibraryService.list")(
    function* (input) {
      return yield* run("list", () => database.listEntries(input));
    },
  );

  const get: LibraryService["Service"]["get"] = Effect.fn("LibraryService.get")(function* (input) {
    return yield* run("get", () => {
      const entry = database.getEntry(input.id);
      if (entry === null) {
        throw new DomainNotFoundError(input.id);
      }
      return { entry: enrichEntry(entry) };
    });
  });

  const save: LibraryService["Service"]["save"] = Effect.fn("LibraryService.save")(
    function* (input) {
      return yield* run("save", () => enrichEntry(database.saveEntry(input)));
    },
  );

  const importTextFile: LibraryService["Service"]["importTextFile"] = Effect.fn(
    "LibraryService.importTextFile",
  )(function* (input) {
    return yield* run("importTextFile", () => enrichEntry(database.importTextFile(input)));
  });

  const update: LibraryService["Service"]["update"] = Effect.fn("LibraryService.update")(
    function* (input) {
      return yield* run("update", () => enrichEntry(database.updateEntry(input)));
    },
  );

  const del: LibraryService["Service"]["delete"] = Effect.fn("LibraryService.delete")(
    function* (input) {
      const deleted = yield* run("delete", () => database.deleteEntry(input));
      // Best-effort delayed GC sweep respects the 10-minute grace period and Windows lock tolerance.
      yield* lock.withPermits(1)(runBlobGcLocked()).pipe(Effect.ignore);
      return deleted;
    },
  );

  const composeDraft: LibraryService["Service"]["composeDraft"] = Effect.fn(
    "LibraryService.composeDraft",
  )(function* (input) {
    const environmentId = yield* environment.getEnvironmentId;
    return yield* run("composeDraft", () =>
      database.composeDraft({
        environmentId,
        entryIds: input.entryIds,
        question: input.question,
      }),
    );
  });

  const uploadPdfStream: LibraryService["Service"]["uploadPdfStream"] = Effect.fn(
    "LibraryService.uploadPdfStream",
  )(function* (input) {
    let staged: StagedPdfBlob | null = null;
    return yield* Effect.gen(function* () {
      staged = yield* Effect.tryPromise({
        try: (signal) =>
          stagePdfBlobFromStream({
            blobsDir,
            chunks: input.chunks,
            maxBytes: input.maxBytes ?? LIBRARY_MAX_PDF_UPLOAD_BYTES,
            isWindows,
            signal,
          }),
        catch: (cause) => mapLibraryError("uploadPdf", cause),
      });

      const extracted = yield* extractPdf(staged.tmpPath);
      const stagedForPublish = staged;
      const title = derivePdfTitle(input.title, extracted.title, input.fileName);

      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const published = yield* Effect.tryPromise({
            try: () =>
              publishStagedPdfBlob({
                blobsDir,
                staged: stagedForPublish,
                isWindows,
              }),
            catch: (cause) => mapLibraryError("publishPdfBlob", cause),
          });
          // Once published, tmpPath has been removed; clear reference so finalizer is a no-op.
          staged = null;

          // If DB commit fails, leave the published blob to delayed GC (never force-delete a
          // potentially concurrently reused content-addressed blob).
          const entry = yield* Effect.try({
            try: () =>
              database.saveEntry({
                kind: "pdf",
                title,
                body: extracted.body,
                note: input.note,
                tags: input.tags,
                pages: extracted.pages,
                pageCount: extracted.pageCount,
                blobSha256: published.sha256,
                blobBytes: published.bytes,
              }),
            catch: (cause) => mapLibraryError("savePdfEntry", cause),
          });
          return enrichEntry(entry);
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          staged === null
            ? Effect.void
            : Effect.promise(() => cleanupStagedBlob(staged!.tmpPath)).pipe(Effect.ignore),
        ),
      ),
    );
  });

  const resolvePdfBlob: LibraryService["Service"]["resolvePdfBlob"] = Effect.fn(
    "LibraryService.resolvePdfBlob",
  )(function* (id) {
    return yield* run("resolvePdfBlob", (): LibraryResolvedPdfBlob => {
      const entry = database.getEntry(id);
      if (entry === null || entry.blobSha256 === null) {
        return { _tag: "NotFound" };
      }
      const filePath = resolveBlobPath(blobsDir, entry.blobSha256);
      if (filePath === null || !blobExistsOnDisk(blobsDir, entry.blobSha256)) {
        return {
          _tag: "BlobMissing",
          entry: { ...entry, blobMissing: true },
        };
      }
      return {
        _tag: "Ready",
        entry: { ...entry, blobMissing: false },
        filePath,
        bytes: entry.blobBytes ?? 0,
      };
    });
  });

  const fetchUrl: LibraryService["Service"]["fetchUrl"] = Effect.fn("LibraryService.fetchUrl")(
    function* (input) {
      const normalizedUrl = yield* Effect.try({
        try: () => {
          const url = normalizeLibraryUrl(input.url);
          if (url === null) {
            throw new DomainValidationError("url", "A valid http or https URL is required.");
          }
          return url;
        },
        catch: (cause) => mapLibraryError("fetchUrl", cause),
      });

      const fetchAttempt = yield* Effect.tryPromise({
        try: (signal) => fetchWebArticle(normalizedUrl, { signal }),
        catch: (cause) => new WebFetchAttemptError({ cause }),
      }).pipe(Effect.result);

      if (fetchAttempt._tag === "Success") {
        const fetched = fetchAttempt.success;
        const entry = yield* run("fetchUrlSave", () =>
          enrichEntry(
            database.saveEntry({
              kind: fetched.kind,
              title: input.title?.trim() || fetched.title,
              url: normalizedUrl,
              body: fetched.body,
              note: input.note,
              tags: input.tags,
            }),
          ),
        );
        return {
          entry,
          fetched: true,
          fallbackReason: null,
        } satisfies LibraryFetchUrlResult;
      }

      const failure = fetchAttempt.failure.cause;
      // Never swallow SSRF or URL validation errors into a saved link!
      if (failure instanceof DomainSsrfRejectedError || failure instanceof DomainValidationError) {
        return yield* mapLibraryError("fetchUrl", failure);
      }

      const reason =
        failure instanceof Error && failure.message.trim().length > 0
          ? failure.message.trim().slice(0, 240)
          : "Could not fetch article content from the remote URL.";

      if (input.allowFallback === false) {
        return yield* new LibraryStorageError({ operation: "fetchUrl", cause: failure });
      }

      const fallbackTitle =
        input.title?.trim() ||
        (() => {
          try {
            return new URL(normalizedUrl).hostname;
          } catch {
            return normalizedUrl.slice(0, LIBRARY_MAX_TITLE_CHARS);
          }
        })();

      const entry = yield* run("fetchUrlFallbackSave", () =>
        enrichEntry(
          database.saveEntry({
            kind: inferWebEntryKind(normalizedUrl),
            title: fallbackTitle,
            url: normalizedUrl,
            body: "",
            note: input.note,
            tags: input.tags,
          }),
        ),
      );

      return {
        entry,
        fetched: false,
        fallbackReason: reason,
      } satisfies LibraryFetchUrlResult;
    },
  );

  const wkbStatus: LibraryService["Service"]["wkbStatus"] = Effect.fn("LibraryService.wkbStatus")(
    function* () {
      if (Option.isNone(wkbService)) {
        return {
          available: false,
          mode: "unavailable",
          remoteUrl: null,
        } satisfies LibraryWkbStatusResult;
      }
      const status = yield* wkbService.value.status;
      return {
        available: status.available,
        mode: status.mode,
        remoteUrl: status.remoteUrl,
      } satisfies LibraryWkbStatusResult;
    },
  );

  const importFromWkb: LibraryService["Service"]["importFromWkb"] = Effect.fn(
    "LibraryService.importFromWkb",
  )(function* (input) {
    if (Option.isNone(wkbService)) {
      return yield* new LibraryWkbError({
        reason: "wkb bridge service is not enabled on this environment.",
      });
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const exported = yield* wkbService.value
          .exportToScopedTemp({
            source: input.source,
            pdf: input.generatePdf === true,
          })
          .pipe(
            Effect.mapError((error) => new LibraryWkbError({ reason: error.reason.slice(0, 400) })),
          );

        let stagedPdf: StagedPdfBlob | null = null;
        return yield* Effect.gen(function* () {
          let extractedPages:
            | {
                readonly pageCount: number;
                readonly pages: ReadonlyArray<{
                  readonly physicalPage: number;
                  readonly text: string;
                  readonly extractionStatus: "ok" | "empty_scan" | "truncated" | "skipped";
                }>;
              }
            | undefined;

          if (exported.pdfPath !== null) {
            stagedPdf = yield* Effect.tryPromise({
              try: (signal) =>
                stagePdfBlobFromFile({
                  blobsDir,
                  sourcePath: exported.pdfPath!,
                  maxBytes: LIBRARY_MAX_PDF_UPLOAD_BYTES,
                  isWindows,
                  signal,
                }),
              catch: (cause) => mapLibraryError("stageWkbPdf", cause),
            });
            const extracted = yield* extractPdf(stagedPdf.tmpPath);
            extractedPages = {
              pageCount: extracted.pageCount,
              pages: extracted.pages,
            };
          }

          const stagedForPublish = stagedPdf;
          const entry = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              let blobSha256: string | null = null;
              let blobBytes: number | null = null;
              if (stagedForPublish !== null) {
                const published = yield* Effect.tryPromise({
                  try: () =>
                    publishStagedPdfBlob({
                      blobsDir,
                      staged: stagedForPublish,
                      isWindows,
                    }),
                  catch: (cause) => mapLibraryError("publishWkbPdfBlob", cause),
                });
                stagedPdf = null;
                blobSha256 = published.sha256;
                blobBytes = published.bytes;
              }

              const saved = yield* Effect.try({
                try: () =>
                  database.saveEntry({
                    kind: exported.inferredKind,
                    title: exported.title.slice(0, LIBRARY_MAX_TITLE_CHARS),
                    url: exported.sourceUrl,
                    body: exported.markdown
                      .replace(/\u0000/gu, "")
                      .slice(0, LIBRARY_MAX_BODY_CHARS),
                    note: input.note,
                    tags: input.tags,
                    pages: extractedPages?.pages,
                    pageCount: extractedPages?.pageCount,
                    blobSha256,
                    blobBytes,
                  }),
                catch: (cause) => mapLibraryError("saveWkbEntry", cause),
              });
              return enrichEntry(saved);
            }),
          );

          return {
            entry,
            warnings: exported.warnings,
          } satisfies LibraryImportFromWkbResult;
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              stagedPdf === null
                ? Effect.void
                : Effect.promise(() => cleanupStagedBlob(stagedPdf!.tmpPath)).pipe(Effect.ignore),
            ),
          ),
        );
      }),
    );
  });

  const readItemForMcp: LibraryService["Service"]["readItemForMcp"] = Effect.fn(
    "LibraryService.readItemForMcp",
  )(function* (input) {
    return yield* run("readItemForMcp", () => {
      const existing = database.getEntry(input.id);
      if (existing === null) {
        throw new DomainNotFoundError(input.id);
      }
      const missing =
        existing.blobSha256 !== null && !blobExistsOnDisk(blobsDir, existing.blobSha256);
      return database.readEntryForMcp(input, { blobMissing: missing });
    });
  });

  const runBlobGc: LibraryService["Service"]["runBlobGc"] = Effect.fn("LibraryService.runBlobGc")(
    function* (options) {
      return yield* lock.withPermits(1)(runBlobGcLocked(options));
    },
  );

  return LibraryService.of({
    list,
    get,
    save,
    importTextFile,
    update,
    delete: del,
    composeDraft,
    uploadPdfStream,
    resolvePdfBlob,
    fetchUrl,
    wkbStatus,
    importFromWkb,
    readItemForMcp,
    runBlobGc,
  });
});

export const layer = Layer.effect(LibraryService, make);

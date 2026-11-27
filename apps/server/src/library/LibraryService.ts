import {
  isSecretReference,
  LibraryAiError,
  type LibraryComposeDraftInput,
  type LibraryComposeDraftResult,
  type LibraryDeleteFeedInput,
  type LibraryDeleteFeedResult,
  type LibraryDeleteInput,
  type LibraryDeleteReadingQuestionInput,
  type LibraryDeleteReadingQuestionResult,
  type LibraryDeleteResult,
  LibraryDuplicateUrlError,
  LibraryEditConflictError,
  type LibraryEntry,
  type LibraryFeedContract,
  type LibraryFetchUrlInput,
  type LibraryFetchUrlResult,
  type LibraryGetInput,
  type LibraryGetReadingStateInput,
  type LibraryGetResult,
  type LibraryImaConfigView,
  LibraryImaError,
  type LibraryImaSearchInput,
  type LibraryImaSearchResult,
  type LibraryImportFromWkbInput,
  type LibraryImportFromWkbResult,
  type LibraryImportGuideInput,
  type LibraryImportTextFileInput,
  type LibraryListFeedsResult,
  type LibraryListInput,
  type LibraryListReadingModelsResult,
  type LibraryListResult,
  LibraryNotFoundError,
  type LibraryReadingInsightContract,
  type LibraryReadingParagraphContract,
  type LibraryReadingQuestionContract,
  type LibraryReadingStateResult,
  type LibraryRpcError,
  type LibraryRunFeedNowInput,
  type LibraryRunFeedNowResult,
  type LibraryRunReadingAiActionInput,
  type LibraryRunReadingAiActionResult,
  type LibraryRunWorkHarvestInput,
  type LibraryRunWorkHarvestResult,
  type LibrarySaveInput,
  type LibrarySetFeedEnabledInput,
  type LibrarySetReadingPositionInput,
  type LibrarySetReadingPositionResult,
  type LibrarySetReadingPreferenceInput,
  LibrarySsrfRejectedError,
  LibraryStorageError,
  type LibrarySubmitToWkbInput,
  type LibrarySubmitToWkbResult,
  type LibrarySyncWkbAnnotationsInput,
  type LibrarySyncWkbAnnotationsResult,
  type LibraryUpdateImaConfigInput,
  type LibraryUpdateInput,
  LibraryUploadTooLargeError,
  type LibraryUpsertFeedInput,
  type LibraryUpsertReadingInsightInput,
  type LibraryUpsertReadingParagraphInput,
  type LibraryUpsertReadingQuestionInput,
  LibraryValidationError,
  LibraryWkbError,
  type LibraryWkbStatusResult,
  SecretReference,
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
  type AppendLibraryNoteIdempotentInput,
  type AppendLibraryNoteIdempotentResult,
  type LibraryBlobGcReport,
  type LibraryFeedKind,
  type LibraryMcpReadItemInput,
  type LibraryMcpReadItemResult,
  type LibraryMcpReadingNotesInput,
  type LibraryMcpReadingNotesResult,
  type ParsedFeedItem,
} from "@t3tools/research-library";
import {
  parseDeepReadGuideImport,
  WKB_ANNOTATION_KINDS,
  type WkbAnnotationKind,
} from "@t3tools/research-library/reader";
import {
  blobExistsOnDisk,
  cleanupStagedBlob,
  fetchFeedItems,
  fetchWebArticle,
  inferWebEntryKind,
  openLibraryDatabase,
  publishStagedPdfBlob,
  recoverAndSweepBlobs,
  resolveBlobPath,
  searchImaKnowledgeBase,
  stagePdfBlobFromFile,
  stagePdfBlobFromStream,
  type StagedPdfBlob,
} from "@t3tools/research-library/server";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as WkbBridgeService from "../wkb/WkbBridgeService.ts";
import { extractPdfInIsolatedProcess } from "./LibraryPdfExtractor.ts";
import * as ReadingAiRunner from "./ReadingAiRunner.ts";

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

export type LibraryFeedFetchFn = (
  url: string,
  kind: LibraryFeedKind,
  signal?: AbortSignal,
) => Promise<ReadonlyArray<ParsedFeedItem>>;

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
    readonly getReadingNotesForMcp: (
      input: LibraryMcpReadingNotesInput,
    ) => Effect.Effect<LibraryMcpReadingNotesResult, LibraryRpcError>;
    readonly appendNoteIdempotent: (
      input: AppendLibraryNoteIdempotentInput,
    ) => Effect.Effect<AppendLibraryNoteIdempotentResult, LibraryRpcError>;
    readonly getReadingState: (
      input: LibraryGetReadingStateInput,
    ) => Effect.Effect<LibraryReadingStateResult, LibraryRpcError>;
    readonly setReadingPosition: (
      input: LibrarySetReadingPositionInput,
    ) => Effect.Effect<LibrarySetReadingPositionResult, LibraryRpcError>;
    readonly upsertReadingParagraph: (
      input: LibraryUpsertReadingParagraphInput,
    ) => Effect.Effect<LibraryReadingParagraphContract, LibraryRpcError>;
    readonly upsertReadingQuestion: (
      input: LibraryUpsertReadingQuestionInput,
    ) => Effect.Effect<LibraryReadingQuestionContract, LibraryRpcError>;
    readonly deleteReadingQuestion: (
      input: LibraryDeleteReadingQuestionInput,
    ) => Effect.Effect<LibraryDeleteReadingQuestionResult, LibraryRpcError>;
    readonly upsertReadingInsight: (
      input: LibraryUpsertReadingInsightInput,
    ) => Effect.Effect<LibraryReadingInsightContract, LibraryRpcError>;
    readonly setReadingPreference: (
      input: LibrarySetReadingPreferenceInput,
    ) => Effect.Effect<void, LibraryRpcError>;
    readonly listReadingModels: () => Effect.Effect<
      LibraryListReadingModelsResult,
      LibraryRpcError
    >;
    readonly runReadingAiAction: (
      input: LibraryRunReadingAiActionInput,
    ) => Effect.Effect<LibraryRunReadingAiActionResult, LibraryRpcError>;
    readonly importGuide: (
      input: LibraryImportGuideInput,
    ) => Effect.Effect<LibraryReadingInsightContract, LibraryRpcError>;
    readonly syncWkbAnnotations: (
      input: LibrarySyncWkbAnnotationsInput,
    ) => Effect.Effect<LibrarySyncWkbAnnotationsResult, LibraryRpcError>;
    readonly submitToWkb: (
      input: LibrarySubmitToWkbInput,
    ) => Effect.Effect<LibrarySubmitToWkbResult, LibraryRpcError>;
    readonly imaStatus: () => Effect.Effect<LibraryImaConfigView, LibraryRpcError>;
    readonly updateImaConfig: (
      input: LibraryUpdateImaConfigInput,
    ) => Effect.Effect<LibraryImaConfigView, LibraryRpcError>;
    readonly imaSearch: (
      input: LibraryImaSearchInput,
    ) => Effect.Effect<LibraryImaSearchResult, LibraryRpcError>;
    readonly listFeeds: () => Effect.Effect<LibraryListFeedsResult, LibraryRpcError>;
    readonly upsertFeed: (
      input: LibraryUpsertFeedInput,
    ) => Effect.Effect<LibraryFeedContract, LibraryRpcError>;
    readonly setFeedEnabled: (
      input: LibrarySetFeedEnabledInput,
    ) => Effect.Effect<LibraryFeedContract, LibraryRpcError>;
    readonly deleteFeed: (
      input: LibraryDeleteFeedInput,
    ) => Effect.Effect<LibraryDeleteFeedResult, LibraryRpcError>;
    readonly runFeedNow: (
      input: LibraryRunFeedNowInput,
      options?: { readonly fetchFeedItemsFn?: LibraryFeedFetchFn | undefined },
    ) => Effect.Effect<LibraryRunFeedNowResult, LibraryRpcError>;
    readonly runDueFeeds: (options?: {
      readonly fetchFeedItemsFn?: LibraryFeedFetchFn | undefined;
    }) => Effect.Effect<ReadonlyArray<LibraryRunFeedNowResult>, LibraryRpcError>;
    readonly runWorkHarvest: (
      input: LibraryRunWorkHarvestInput,
    ) => Effect.Effect<LibraryRunWorkHarvestResult, LibraryRpcError>;
    readonly runBlobGc: (options?: {
      readonly orphanGraceMs?: number | undefined;
      readonly tempGraceMs?: number | undefined;
      readonly unlinkFn?: ((filePath: string) => Promise<void>) | undefined;
    }) => Effect.Effect<LibraryBlobGcReport, LibraryRpcError>;
  }
>()("t3/library/LibraryService") {}

const IMA_SECRET_KEY = "library-ima-api-key";
const VALID_WKB_KINDS: ReadonlySet<string> = new Set(WKB_ANNOTATION_KINDS);
const imaEncoder = new TextEncoder();
const imaDecoder = new TextDecoder();

const StoredImaConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  baseUrl: Schema.String,
  knowledgeBaseId: Schema.String,
  apiKeyRef: Schema.optional(SecretReference),
});
type StoredImaConfig = typeof StoredImaConfigSchema.Type;
const StoredImaConfigJson = Schema.fromJsonString(StoredImaConfigSchema);
const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeUnknownJson = Schema.encodeEffect(UnknownJsonString);
const decodeStoredImaConfig = Schema.decodeEffect(StoredImaConfigJson);
const encodeStoredImaConfig = Schema.encodeEffect(StoredImaConfigJson);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const wkbService = yield* Effect.serviceOption(WkbBridgeService.WkbBridgeService);
  const readingAiOpt = yield* Effect.serviceOption(ReadingAiRunner.ReadingAiRunner);
  const secretStoreOpt = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const secretResolverOpt = yield* Effect.serviceOption(SecretResolver.SecretResolver);
  const fsOpt = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const platform = yield* HostProcess.Platform;
  const isWindows = platform === "win32";
  const libraryDir = path.join(config.stateDir, "research-library");
  const dbPath = path.join(libraryDir, "library.sqlite");
  const blobsDir = path.join(libraryDir, "blobs");
  const imaConfigPath = path.join(libraryDir, "ima.json");

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
      const enriched = enrichEntry(entry);
      if (input.maxBodyChars !== undefined && enriched.body.length > input.maxBodyChars) {
        return {
          entry: {
            ...enriched,
            body: enriched.body.slice(0, input.maxBodyChars),
          },
        };
      }
      return { entry: enriched };
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
          syncAvailable: false,
          mode: "unavailable",
          remoteUrl: null,
        } satisfies LibraryWkbStatusResult;
      }
      const status = yield* wkbService.value.status;
      return {
        available: status.available,
        syncAvailable: status.syncAvailable,
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

  const getReadingNotesForMcp: LibraryService["Service"]["getReadingNotesForMcp"] = Effect.fn(
    "LibraryService.getReadingNotesForMcp",
  )(function* (input) {
    return yield* run("getReadingNotesForMcp", () => database.getReadingNotesForMcp(input));
  });

  const appendNoteIdempotent: LibraryService["Service"]["appendNoteIdempotent"] = Effect.fn(
    "LibraryService.appendNoteIdempotent",
  )(function* (input) {
    return yield* run("appendNoteIdempotent", () => {
      const res = database.appendNoteIdempotent(input);
      return {
        entry: enrichEntry(res.entry),
        deduplicated: res.deduplicated,
      };
    });
  });

  const getReadingState: LibraryService["Service"]["getReadingState"] = Effect.fn(
    "LibraryService.getReadingState",
  )(function* (input) {
    return yield* run("getReadingState", () => {
      const state = database.getReadingState(input.entryId, {
        includePages: input.includePages,
      });
      return {
        entryId: state.entryId,
        physicalPage: state.physicalPage,
        paragraphs: [...state.paragraphs],
        questions: [...state.questions],
        insights: [...state.insights],
        preferences: { ...state.preferences },
        pages: [...state.pages],
      };
    });
  });

  const setReadingPosition: LibraryService["Service"]["setReadingPosition"] = Effect.fn(
    "LibraryService.setReadingPosition",
  )(function* (input) {
    return yield* run("setReadingPosition", () => ({
      physicalPage: database.setReadingPosition(input.entryId, input.physicalPage),
    }));
  });

  const upsertReadingParagraph: LibraryService["Service"]["upsertReadingParagraph"] = Effect.fn(
    "LibraryService.upsertReadingParagraph",
  )(function* (input) {
    return yield* run("upsertReadingParagraph", () => database.upsertReadingParagraph(input));
  });

  const upsertReadingQuestion: LibraryService["Service"]["upsertReadingQuestion"] = Effect.fn(
    "LibraryService.upsertReadingQuestion",
  )(function* (input) {
    return yield* run("upsertReadingQuestion", () => database.upsertReadingQuestion(input));
  });

  const deleteReadingQuestion: LibraryService["Service"]["deleteReadingQuestion"] = Effect.fn(
    "LibraryService.deleteReadingQuestion",
  )(function* (input) {
    return yield* run("deleteReadingQuestion", () => ({
      deleted: database.deleteReadingQuestion(input.entryId, input.questionId),
    }));
  });

  const upsertReadingInsight: LibraryService["Service"]["upsertReadingInsight"] = Effect.fn(
    "LibraryService.upsertReadingInsight",
  )(function* (input) {
    return yield* run("upsertReadingInsight", () => database.upsertReadingInsight(input));
  });

  const setReadingPreference: LibraryService["Service"]["setReadingPreference"] = Effect.fn(
    "LibraryService.setReadingPreference",
  )(function* (input) {
    yield* run("setReadingPreference", () => {
      database.setReadingPreference(input.scopeKey, input.valueJson);
    });
  });

  const listReadingModels: LibraryService["Service"]["listReadingModels"] = Effect.fn(
    "LibraryService.listReadingModels",
  )(function* () {
    if (Option.isNone(readingAiOpt)) {
      return { models: [] };
    }
    const models = yield* readingAiOpt.value.listModels;
    return { models: [...models] };
  });

  const runReadingAiAction: LibraryService["Service"]["runReadingAiAction"] = Effect.fn(
    "LibraryService.runReadingAiAction",
  )(function* (input) {
    if (Option.isNone(readingAiOpt)) {
      return yield* new LibraryAiError({
        reason: "Reading AI runner is not available on this server.",
      });
    }
    const { entry, pages } = yield* run("loadForAiAction", () => {
      const found = database.getEntry(input.entryId);
      if (!found) throw new DomainNotFoundError(input.entryId);
      return {
        entry: enrichEntry(found),
        pages: [...database.getEntryPages(input.entryId)],
      };
    });

    // Execute AI action BEFORE touching SQLite so cancellation or failure never persists dirty state.
    const executed = yield* readingAiOpt.value.executeAction({
      entry,
      pages,
      action: input.action,
      physicalPage: input.physicalPage,
      quote: input.quote,
      figureLabel: input.figureLabel,
      question: input.question,
      instanceId: input.instanceId,
      model: input.model,
      strictModel: input.strictModel,
    });

    const payloadJson = yield* encodeUnknownJson(executed.payload).pipe(
      Effect.orElseSucceed(() => "{}"),
    );

    if (input.action === "analyze_paragraph" && input.anchor && input.physicalPage !== undefined) {
      const paragraph = yield* run("persistParagraphAnalysis", () =>
        database.upsertReadingParagraph({
          entryId: entry.id,
          physicalPage: input.physicalPage!,
          anchor: input.anchor!,
          quote: input.quote ?? "",
          analysisJson: payloadJson,
        }),
      );
      return {
        action: input.action,
        route: executed.route,
        modelId: executed.modelId,
        payloadJson,
        paragraph,
      };
    }

    if (input.action === "ask_question" && input.question) {
      const parsed = executed.payload as { answer?: string; sources?: unknown };
      const question = yield* run("persistQuestionAnswer", () =>
        database.upsertReadingQuestion({
          id: input.questionId,
          entryId: entry.id,
          physicalPage: input.physicalPage ?? 1,
          anchor: input.anchor ?? null,
          question: input.question!,
          answer: typeof parsed.answer === "string" ? parsed.answer : payloadJson,
          sourcesJson: JSON.stringify(Array.isArray(parsed.sources) ? parsed.sources : []),
          modelId: executed.modelId,
        }),
      );
      return {
        action: input.action,
        route: executed.route,
        modelId: executed.modelId,
        payloadJson,
        question,
      };
    }

    const insightKind =
      input.action === "figure_explain"
        ? `figure:${(input.figureLabel ?? "fig").toLowerCase().replaceAll(/\s+/gu, "_")}`
        : input.action;
    const insight = yield* run("persistReadingInsight", () =>
      database.upsertReadingInsight({
        entryId: entry.id,
        kind: insightKind,
        payloadJson,
        modelId: executed.modelId,
      }),
    );
    return {
      action: input.action,
      route: executed.route,
      modelId: executed.modelId,
      payloadJson,
      insight,
    };
  });

  const importGuide: LibraryService["Service"]["importGuide"] = Effect.fn(
    "LibraryService.importGuide",
  )(function* (input) {
    const parsed = yield* Effect.try({
      try: () => parseDeepReadGuideImport(input.content),
      catch: (cause) =>
        new LibraryValidationError({
          field: "content",
          reason:
            cause instanceof Error ? cause.message.slice(0, 240) : "Invalid DeepRead guide format.",
        }),
    });
    return yield* run("importGuide", () =>
      database.upsertReadingInsight({
        entryId: input.entryId,
        kind: "guide",
        payloadJson: JSON.stringify(parsed),
        modelId: "import",
      }),
    );
  });

  const syncWkbAnnotations: LibraryService["Service"]["syncWkbAnnotations"] = Effect.fn(
    "LibraryService.syncWkbAnnotations",
  )(function* (input) {
    if (Option.isNone(wkbService)) {
      return yield* new LibraryWkbError({
        reason: "wkb bridge service is not enabled on this server.",
      });
    }
    const state = yield* run("loadAnnotationsForWkb", () =>
      database.getReadingState(input.entryId),
    );
    const annotations = state.paragraphs
      .filter((p) => p.highlighted || p.marked || p.note.trim().length > 0 || p.wkbKind.length > 0)
      .map((p) => {
        const kind: WkbAnnotationKind = VALID_WKB_KINDS.has(p.wkbKind)
          ? (p.wkbKind as WkbAnnotationKind)
          : p.marked
            ? "存疑"
            : "重点";
        return {
          id: `${p.entryId}:${p.physicalPage}:${p.anchor}`,
          kind,
          ...(p.highlightColor ? { color: p.highlightColor } : {}),
          text: p.quote,
          ...(p.note.trim() ? { note: p.note.trim() } : {}),
          location: { page: p.physicalPage },
          updated: p.updatedAt,
        };
      });

    if (annotations.length === 0) {
      return { mode: "local", summary: "No highlights or notes to sync.", syncedCount: 0 };
    }

    const result = yield* wkbService.value
      .annotate({
        sourceId: input.sourceId,
        annotations,
      })
      .pipe(Effect.mapError((error) => new LibraryWkbError({ reason: error.message })));

    yield* run("recordWkbLink", () =>
      database.upsertReadingInsight({
        entryId: input.entryId,
        kind: "wkb_link",
        payloadJson: JSON.stringify({
          sourceId: input.sourceId,
          mode: result.mode,
          status: result.queued === true ? "queued" : "synced",
          syncedCount: result.syncedCount,
        }),
      }),
    );

    return result;
  });

  const submitToWkb: LibraryService["Service"]["submitToWkb"] = Effect.fn(
    "LibraryService.submitToWkb",
  )(function* (input) {
    if (Option.isNone(wkbService)) {
      return yield* new LibraryWkbError({
        reason: "wkb bridge service is not enabled on this server.",
      });
    }
    const { entry, state } = yield* run("loadEntryForWkbSubmit", () => {
      const found = database.getEntry(input.entryId);
      if (!found) throw new DomainNotFoundError(input.entryId);
      return {
        entry: enrichEntry(found),
        state: database.getReadingState(input.entryId),
      };
    });
    const extraNotes = state.paragraphs
      .filter((p) => p.note.trim().length > 0 || p.marked)
      .map((p) => `- [p.${p.physicalPage}] ${p.note || p.quote}`)
      .join("\n");
    const combinedNote = [input.note?.trim(), entry.note.trim(), extraNotes]
      .filter(Boolean)
      .join("\n\n");

    const submitKind =
      entry.kind === "pdf"
        ? "pdf"
        : entry.kind === "video"
          ? "video"
          : entry.kind === "epub"
            ? "epub"
            : entry.url
              ? "article"
              : "text";

    return yield* wkbService.value
      .submit({
        title: entry.title,
        url: entry.url,
        text: entry.body || state.pages.map((p) => `[p.${p.physicalPage}]\n${p.text}`).join("\n\n"),
        kind: submitKind,
        tags: entry.tags,
        ...(combinedNote ? { note: combinedNote } : {}),
      })
      .pipe(Effect.mapError((error) => new LibraryWkbError({ reason: error.message })));
  });

  const readImaConfig = Effect.fn("LibraryService.readImaConfig")(function* () {
    const fallback: StoredImaConfig = { enabled: false, baseUrl: "", knowledgeBaseId: "" };
    if (Option.isNone(fsOpt)) return fallback;
    const exists = yield* fsOpt.value.exists(imaConfigPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return fallback;
    const raw = yield* fsOpt.value
      .readFileString(imaConfigPath)
      .pipe(Effect.orElseSucceed(() => ""));
    if (!raw.trim()) return fallback;
    return yield* decodeStoredImaConfig(raw).pipe(Effect.orElseSucceed(() => fallback));
  });

  const hasStoredImaSecret = Effect.fn("LibraryService.hasStoredImaSecret")(function* (
    cfg: StoredImaConfig,
  ) {
    if (cfg.apiKeyRef !== undefined && isSecretReference(cfg.apiKeyRef)) return true;
    if (Option.isNone(secretStoreOpt)) return false;
    const stored = yield* secretStoreOpt.value
      .get(IMA_SECRET_KEY)
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    return Option.isSome(stored) && stored.value.byteLength > 0;
  });

  const resolveImaApiKey = Effect.fn("LibraryService.resolveImaApiKey")(function* (
    cfg: StoredImaConfig,
  ) {
    if (cfg.apiKeyRef !== undefined && isSecretReference(cfg.apiKeyRef)) {
      if (Option.isNone(secretResolverOpt)) {
        return yield* new LibraryImaError({
          reason: "SecretResolver is unavailable to resolve ima secret reference.",
        });
      }
      return yield* requireSettingsSecret(secretResolverOpt.value, cfg.apiKeyRef).pipe(
        Effect.mapError((cause) => new LibraryImaError({ reason: cause.message.slice(0, 400) })),
      );
    }
    if (Option.isNone(secretStoreOpt)) {
      return yield* new LibraryImaError({ reason: "ServerSecretStore is unavailable." });
    }
    const stored = yield* secretStoreOpt.value
      .get(IMA_SECRET_KEY)
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isNone(stored)) {
      return yield* new LibraryImaError({ reason: "ima API key is not configured." });
    }
    const key = imaDecoder.decode(stored.value).trim();
    if (!key) {
      return yield* new LibraryImaError({ reason: "ima API key is empty." });
    }
    return key;
  });

  const imaStatus: LibraryService["Service"]["imaStatus"] = Effect.fn("LibraryService.imaStatus")(
    function* () {
      const cfg = yield* readImaConfig();
      const hasApiKey = yield* hasStoredImaSecret(cfg);
      return {
        enabled: cfg.enabled,
        baseUrl: cfg.baseUrl,
        knowledgeBaseId: cfg.knowledgeBaseId,
        hasApiKey,
      };
    },
  );

  const updateImaConfig: LibraryService["Service"]["updateImaConfig"] = Effect.fn(
    "LibraryService.updateImaConfig",
  )(function* (input) {
    const current = yield* readImaConfig();
    let apiKeyRef = current.apiKeyRef;

    if (input.apiKey !== undefined) {
      if (input.apiKey === null) {
        apiKeyRef = undefined;
        if (Option.isSome(secretStoreOpt)) {
          yield* secretStoreOpt.value
            .remove(IMA_SECRET_KEY)
            .pipe(
              Effect.mapError(
                (cause) => new LibraryImaError({ reason: cause.message.slice(0, 400) }),
              ),
            );
        }
      } else if (isSecretReference(input.apiKey)) {
        apiKeyRef = input.apiKey;
        if (Option.isSome(secretStoreOpt)) {
          yield* secretStoreOpt.value.remove(IMA_SECRET_KEY).pipe(Effect.ignore);
        }
      } else {
        apiKeyRef = undefined;
        const trimmed = input.apiKey.trim();
        if (Option.isSome(secretStoreOpt)) {
          if (trimmed) {
            yield* secretStoreOpt.value
              .set(IMA_SECRET_KEY, imaEncoder.encode(trimmed))
              .pipe(
                Effect.mapError(
                  (cause) => new LibraryImaError({ reason: cause.message.slice(0, 400) }),
                ),
              );
          } else {
            yield* secretStoreOpt.value.remove(IMA_SECRET_KEY).pipe(Effect.ignore);
          }
        }
      }
    }

    const next: StoredImaConfig = {
      enabled: input.enabled ?? current.enabled,
      baseUrl: input.baseUrl !== undefined ? input.baseUrl.trim() : current.baseUrl,
      knowledgeBaseId:
        input.knowledgeBaseId !== undefined
          ? input.knowledgeBaseId.trim()
          : current.knowledgeBaseId,
      ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
    };

    if (Option.isSome(fsOpt)) {
      const encoded = yield* encodeStoredImaConfig(next).pipe(
        Effect.mapError((cause) => new LibraryImaError({ reason: cause.message.slice(0, 400) })),
      );
      yield* fsOpt.value.makeDirectory(libraryDir, { recursive: true }).pipe(Effect.ignore);
      yield* fsOpt.value
        .writeFileString(imaConfigPath, `${encoded}\n`)
        .pipe(
          Effect.mapError((cause) => new LibraryImaError({ reason: cause.message.slice(0, 400) })),
        );
    }

    const hasApiKey = yield* hasStoredImaSecret(next);
    return {
      enabled: next.enabled,
      baseUrl: next.baseUrl,
      knowledgeBaseId: next.knowledgeBaseId,
      hasApiKey,
    };
  });

  const imaSearch: LibraryService["Service"]["imaSearch"] = Effect.fn("LibraryService.imaSearch")(
    function* (input) {
      const cfg = yield* readImaConfig();
      if (!cfg.enabled || !cfg.baseUrl) {
        return yield* new LibraryImaError({
          reason: "ima knowledge base integration is not enabled on this environment.",
        });
      }
      const apiKey = yield* resolveImaApiKey(cfg);
      const hits = yield* Effect.tryPromise({
        try: (signal) =>
          searchImaKnowledgeBase({
            baseUrl: cfg.baseUrl,
            apiKey,
            knowledgeBaseId: cfg.knowledgeBaseId,
            query: input.query,
            limit: input.limit,
            signal,
          }),
        catch: (cause) => {
          if (cause instanceof DomainSsrfRejectedError || cause instanceof DomainValidationError) {
            return mapLibraryError("imaSearch", cause);
          }
          return new LibraryImaError({
            reason:
              cause instanceof Error ? cause.message.slice(0, 400) : "ima search request failed.",
          });
        },
      });
      return { hits: [...hits] };
    },
  );

  const feedTickLock = yield* Semaphore.make(1);
  const inFlightFeedFibers = new Map<string, Set<Fiber.Fiber<unknown, unknown>>>();

  const interruptInFlightFeed = (feedId: string) => {
    const active = inFlightFeedFibers.get(feedId);
    if (!active || active.size === 0) return Effect.void;
    const snapshot = [...active];
    inFlightFeedFibers.delete(feedId);
    return Effect.forEach(snapshot, (fiber) => Fiber.interrupt(fiber), {
      concurrency: "unbounded",
      discard: true,
    });
  };

  const listFeeds: LibraryService["Service"]["listFeeds"] = Effect.fn("LibraryService.listFeeds")(
    function* () {
      return yield* run("listFeeds", () => ({
        feeds: [...database.listFeeds()],
        dailyAiUsed: database.getDailyAiUsageCount(),
      }));
    },
  );

  const upsertFeed: LibraryService["Service"]["upsertFeed"] = Effect.fn(
    "LibraryService.upsertFeed",
  )(function* (input) {
    const saved = yield* run("upsertFeed", () => database.upsertFeed(input));
    if (!saved.enabled) {
      yield* interruptInFlightFeed(saved.id);
    }
    return saved;
  });

  const setFeedEnabled: LibraryService["Service"]["setFeedEnabled"] = Effect.fn(
    "LibraryService.setFeedEnabled",
  )(function* (input) {
    const updated = yield* run("setFeedEnabled", () =>
      database.setFeedEnabled(input.id, input.enabled),
    );
    if (!input.enabled) {
      yield* interruptInFlightFeed(updated.id);
    }
    return updated;
  });

  const deleteFeed: LibraryService["Service"]["deleteFeed"] = Effect.fn(
    "LibraryService.deleteFeed",
  )(function* (input) {
    const res = yield* run("deleteFeed", () => ({
      deleted: database.deleteFeed(input.id),
    }));
    yield* interruptInFlightFeed(input.id.trim());
    return res;
  });

  interface MutableFeedRunProgress {
    fetchedCount: number;
    importedCount: number;
    deduplicatedCount: number;
    summarizedCount: number;
    budgetExhaustedCount: number;
    readonly importedEntryIds: string[];
    readonly errors: string[];
  }

  const executeFeedRunBody = Effect.fn("LibraryService.executeFeedRunBody")(function* (
    feed: LibraryFeedContract,
    progress: MutableFeedRunProgress,
    options?: { readonly fetchFeedItemsFn?: LibraryFeedFetchFn | undefined },
  ) {
    const fetchFn: LibraryFeedFetchFn =
      options?.fetchFeedItemsFn ??
      ((url, kind, signal) => fetchFeedItems(url, kind, { signal, timeoutMs: 20_000 }));

    const fetchedOutcome = yield* Effect.tryPromise({
      try: (signal) => fetchFn(feed.url, feed.kind, signal),
      catch: (cause) => new WebFetchAttemptError({ cause }),
    }).pipe(Effect.result);

    const afterFetchFeed = yield* run("recheckFeedAfterFetch", () => database.getFeed(feed.id));
    if (!afterFetchFeed) {
      return yield* new LibraryNotFoundError({ entryId: feed.id });
    }
    if (!afterFetchFeed.enabled) {
      return {
        feed: afterFetchFeed,
        skippedPaused: true,
        fetchedCount: 0,
        importedCount: 0,
        deduplicatedCount: 0,
        summarizedCount: 0,
        budgetExhaustedCount: 0,
        importedEntryIds: [],
        errors: [],
      } satisfies LibraryRunFeedNowResult;
    }

    if (fetchedOutcome._tag === "Failure") {
      const cause = fetchedOutcome.failure.cause;
      const reason =
        cause instanceof Error ? cause.message.slice(0, 400) : "Feed fetch failed unexpectedly.";
      progress.errors.push(reason);
      const updatedFeed = yield* run("recordFeedRunError", () =>
        database.recordFeedRun({
          feedId: feed.id,
          status: "error",
          error: reason,
          importedCount: 0,
        }),
      );
      if (cause instanceof DomainSsrfRejectedError || cause instanceof DomainValidationError) {
        return yield* mapLibraryError("runFeedNow", cause);
      }
      return {
        feed: updatedFeed,
        skippedPaused: false,
        fetchedCount: 0,
        importedCount: 0,
        deduplicatedCount: 0,
        summarizedCount: 0,
        budgetExhaustedCount: 0,
        importedEntryIds: [],
        errors: [...progress.errors],
      } satisfies LibraryRunFeedNowResult;
    }

    const fetchedItems = fetchedOutcome.success;
    progress.fetchedCount = fetchedItems.length;
    let pausedMidRun = false;

    for (const item of fetchedItems) {
      if (progress.importedCount >= afterFetchFeed.maxItemsPerRun) {
        break;
      }

      const headerLines = [
        item.authors.length > 0 ? `Authors: ${item.authors.join(", ")}` : null,
        item.publishedAt ? `Published: ${item.publishedAt}` : null,
        item.categories.length > 0 ? `Categories: ${item.categories.join(", ")}` : null,
      ].filter((line): line is string => line !== null);

      const body = [...headerLines, item.summary]
        .filter((part) => part.trim().length > 0)
        .join("\n\n")
        .slice(0, LIBRARY_MAX_BODY_CHARS);

      const mergedTags = [
        ...afterFetchFeed.tags,
        ...item.categories.slice(0, 4).map((cat) => cat.slice(0, 64)),
      ];

      const ingestOutcome = yield* run("ingestFeedItem", () =>
        database.ingestFeedItem({
          feedId: feed.id,
          externalId: item.externalId,
          title: item.title,
          url: item.url,
          body,
          tags: mergedTags,
        }),
      ).pipe(Effect.result);

      if (ingestOutcome._tag === "Failure") {
        progress.errors.push(`${item.title}: ${ingestOutcome.failure.message}`);
        continue;
      }

      const ingested = ingestOutcome.success;
      if (ingested.status === "paused_or_missing") {
        pausedMidRun = true;
        break;
      }
      if (ingested.status === "deduplicated") {
        progress.deduplicatedCount += 1;
        continue;
      }

      const savedEntry = enrichEntry(ingested.entry);
      progress.importedCount += 1;
      progress.importedEntryIds.push(savedEntry.id);

      const currentFeedBeforeAi = yield* run("recheckFeedBeforeAi", () =>
        database.getFeed(feed.id),
      );
      if (!currentFeedBeforeAi || !currentFeedBeforeAi.enabled) {
        pausedMidRun = true;
        break;
      }

      if (
        currentFeedBeforeAi.autoSummarize &&
        currentFeedBeforeAi.aiInstanceId &&
        currentFeedBeforeAi.aiModel
      ) {
        const budgetAttempt = yield* run("consumeDailyAiBudget", () =>
          database.consumeDailyAiBudget(currentFeedBeforeAi.dailyAiBudget, undefined, feed.id),
        );
        if (!budgetAttempt.allowed) {
          const feedAfterBudgetCheck = yield* run("recheckFeedAfterBudgetDeny", () =>
            database.getFeed(feed.id),
          );
          if (!feedAfterBudgetCheck || !feedAfterBudgetCheck.enabled) {
            pausedMidRun = true;
            break;
          }
          progress.budgetExhaustedCount += 1;
        } else {
          const aiOutcome = yield* runReadingAiAction({
            entryId: savedEntry.id,
            action: "summary5",
            instanceId: currentFeedBeforeAi.aiInstanceId,
            model: currentFeedBeforeAi.aiModel,
            strictModel: true,
          }).pipe(Effect.result);
          if (aiOutcome._tag === "Success") {
            progress.summarizedCount += 1;
          } else {
            progress.errors.push(`AI summary (${savedEntry.title}): ${aiOutcome.failure.message}`);
          }
        }
      }
    }

    const latestFeed = yield* run("getLatestFeedAfterLoop", () => database.getFeed(feed.id));
    if (!latestFeed) {
      return yield* new LibraryNotFoundError({ entryId: feed.id });
    }
    if (pausedMidRun || !latestFeed.enabled) {
      return {
        feed: latestFeed,
        skippedPaused: progress.importedCount === 0,
        fetchedCount: progress.fetchedCount,
        importedCount: progress.importedCount,
        deduplicatedCount: progress.deduplicatedCount,
        summarizedCount: progress.summarizedCount,
        budgetExhaustedCount: progress.budgetExhaustedCount,
        importedEntryIds: [...progress.importedEntryIds],
        errors: [...progress.errors],
      } satisfies LibraryRunFeedNowResult;
    }

    const finalFeed = yield* run("recordFeedRun", () =>
      database.recordFeedRun({
        feedId: feed.id,
        status: progress.errors.length > 0 ? "partial" : "ok",
        error: progress.errors.length > 0 ? progress.errors.join("; ").slice(0, 400) : null,
        importedCount: progress.importedCount,
      }),
    );

    return {
      feed: finalFeed,
      skippedPaused: false,
      fetchedCount: progress.fetchedCount,
      importedCount: progress.importedCount,
      deduplicatedCount: progress.deduplicatedCount,
      summarizedCount: progress.summarizedCount,
      budgetExhaustedCount: progress.budgetExhaustedCount,
      importedEntryIds: [...progress.importedEntryIds],
      errors: [...progress.errors],
    } satisfies LibraryRunFeedNowResult;
  });

  const runFeedNow: LibraryService["Service"]["runFeedNow"] = Effect.fn(
    "LibraryService.runFeedNow",
  )(function* (input, options) {
    const feed = yield* run("getFeed", () => database.getFeed(input.id));
    if (!feed) {
      return yield* new LibraryNotFoundError({ entryId: input.id });
    }

    if (!feed.enabled) {
      return {
        feed,
        skippedPaused: true,
        fetchedCount: 0,
        importedCount: 0,
        deduplicatedCount: 0,
        summarizedCount: 0,
        budgetExhaustedCount: 0,
        importedEntryIds: [],
        errors: [],
      };
    }

    const progress: MutableFeedRunProgress = {
      fetchedCount: 0,
      importedCount: 0,
      deduplicatedCount: 0,
      summarizedCount: 0,
      budgetExhaustedCount: 0,
      importedEntryIds: [],
      errors: [],
    };

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkScoped(
          executeFeedRunBody(feed, progress, options).pipe(
            Effect.timeoutOption(Duration.minutes(2)),
          ),
        );
        let set = inFlightFeedFibers.get(feed.id);
        if (!set) {
          set = new Set();
          inFlightFeedFibers.set(feed.id, set);
        }
        set.add(fiber);

        const exit = yield* Fiber.await(fiber).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const currentSet = inFlightFeedFibers.get(feed.id);
              if (currentSet) {
                currentSet.delete(fiber);
                if (currentSet.size === 0) inFlightFeedFibers.delete(feed.id);
              }
            }),
          ),
        );

        if (exit._tag === "Success") {
          if (Option.isSome(exit.value)) {
            return exit.value.value;
          }
          const timeoutReason = "Feed run timed out after 2 minutes.";
          progress.errors.push(timeoutReason);
          const timedOutFeed = yield* run("recordFeedRunTimeout", () =>
            database.recordFeedRun({
              feedId: feed.id,
              status: progress.importedCount > 0 ? "partial" : "error",
              error: progress.errors.join("; ").slice(0, 400),
              importedCount: progress.importedCount,
            }),
          );
          return {
            feed: timedOutFeed,
            skippedPaused: false,
            fetchedCount: progress.fetchedCount,
            importedCount: progress.importedCount,
            deduplicatedCount: progress.deduplicatedCount,
            summarizedCount: progress.summarizedCount,
            budgetExhaustedCount: progress.budgetExhaustedCount,
            importedEntryIds: [...progress.importedEntryIds],
            errors: [...progress.errors],
          } satisfies LibraryRunFeedNowResult;
        }

        // If interrupted because the user paused the feed mid-run, preserve actual progress counts.
        const current = yield* run("getFeedAfterExit", () => database.getFeed(feed.id));
        if (current && !current.enabled) {
          return {
            feed: current,
            skippedPaused: progress.importedCount === 0,
            fetchedCount: progress.fetchedCount,
            importedCount: progress.importedCount,
            deduplicatedCount: progress.deduplicatedCount,
            summarizedCount: progress.summarizedCount,
            budgetExhaustedCount: progress.budgetExhaustedCount,
            importedEntryIds: [...progress.importedEntryIds],
            errors: [...progress.errors],
          };
        }
        return yield* Effect.failCause(exit.cause);
      }),
    );
  });

  const runDueFeeds: LibraryService["Service"]["runDueFeeds"] = Effect.fn(
    "LibraryService.runDueFeeds",
  )(function* (options) {
    const acquired = yield* feedTickLock.withPermitsIfAvailable(1)(
      Effect.gen(function* () {
        const nowMs = yield* clock.currentTimeMillis;
        const feeds = yield* run("listFeedsForTick", () => database.listFeeds());
        const results: LibraryRunFeedNowResult[] = [];
        for (const feed of feeds) {
          if (!feed.enabled) continue;
          const lastRunMs = feed.lastRunAt
            ? Option.match(DateTime.make(feed.lastRunAt), {
                onNone: () => 0,
                onSome: DateTime.toEpochMillis,
              })
            : 0;
          const intervalMs = feed.intervalMinutes * 60_000;
          if (feed.lastRunAt !== null && nowMs - lastRunMs < intervalMs) {
            continue;
          }
          // runFeedNow enforces its own 2-minute deadline and records timeout status in SQLite.
          const timedOutcome = yield* runFeedNow({ id: feed.id }, options).pipe(Effect.result);
          if (timedOutcome._tag === "Success") {
            results.push(timedOutcome.success);
          }
        }
        return results;
      }),
    );
    return Option.getOrElse(acquired, () => []);
  });

  const runWorkHarvest: LibraryService["Service"]["runWorkHarvest"] = Effect.fn(
    "LibraryService.runWorkHarvest",
  )(function* (input) {
    if (Option.isNone(wkbService)) {
      return yield* new LibraryWkbError({
        reason: "wkb bridge service is not enabled on this server.",
      });
    }
    return yield* wkbService.value
      .workHarvest({
        project: input.project,
        report: input.report,
        files: input.files,
        projectBlurb: input.projectBlurb,
        commits: input.commits,
        summary: input.summary,
      })
      .pipe(Effect.mapError((error) => new LibraryWkbError({ reason: error.message })));
  });

  // Scoped periodic feed tick (60s cadence). Cleanly interrupted on scope shutdown;
  // under TestClock it never fires unless TestClock.adjust is invoked.
  yield* Effect.forkScoped(
    Effect.sleep(Duration.seconds(60)).pipe(
      Effect.andThen(runDueFeeds().pipe(Effect.ignore)),
      Effect.forever,
    ),
  );

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
    getReadingNotesForMcp,
    appendNoteIdempotent,
    getReadingState,
    setReadingPosition,
    upsertReadingParagraph,
    upsertReadingQuestion,
    deleteReadingQuestion,
    upsertReadingInsight,
    setReadingPreference,
    listReadingModels,
    runReadingAiAction,
    importGuide,
    syncWkbAnnotations,
    submitToWkb,
    imaStatus,
    updateImaConfig,
    imaSearch,
    listFeeds,
    upsertFeed,
    setFeedEnabled,
    deleteFeed,
    runFeedNow,
    runDueFeeds,
    runWorkHarvest,
    runBlobGc,
  });
});

export const layer = Layer.effect(LibraryService, make);

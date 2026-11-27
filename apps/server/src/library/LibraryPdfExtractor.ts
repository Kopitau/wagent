// @effect-diagnostics nodeBuiltinImport:off -- Isolated PDF parser spawns a child process via node:child_process and node:url.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import {
  LIBRARY_PAGE_EXTRACTION_STATUSES,
  LIBRARY_PDF_EXTRACT_TIMEOUT_MS,
  type LibraryExtractedPdf,
} from "@t3tools/research-library";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sharedDocumentParseSemaphore } from "../provider/DocumentText.ts";

const ExtractedPdfSchema = Schema.fromJsonString(
  Schema.Struct({
    pageCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    title: Schema.NullOr(Schema.String),
    body: Schema.String,
    pages: Schema.Array(
      Schema.Struct({
        physicalPage: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
        text: Schema.String,
        extractionStatus: Schema.Literals(LIBRARY_PAGE_EXTRACTION_STATUSES),
      }),
    ),
  }),
);

const decodeExtractedPdf = Schema.decodeUnknownEffect(ExtractedPdfSchema);

export class LibraryPdfWorkerError extends Schema.TaggedError<LibraryPdfWorkerError>()(
  "LibraryPdfWorkerError",
  {
    rejected: Schema.Boolean,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const workerEntryPath = NodeURL.fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
);

/**
 * Spawns the isolated `__library-extract-pdf` child process under the same 2-slot
 * `sharedDocumentParseSemaphore` used by `DocumentText`, with `ELECTRON_RUN_AS_NODE=1`,
 * 35s timeout, bounded heap/stdout, and fiber-cancellation AbortSignal wiring.
 */
export const extractPdfInIsolatedProcess = Effect.fn("LibraryPdfExtractor.extract")(function* (
  pdfFilePath: string,
  options?: { readonly timeoutMs?: number | undefined },
): Effect.fn.Return<LibraryExtractedPdf, LibraryPdfWorkerError> {
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  const timeoutMs = options?.timeoutMs ?? LIBRARY_PDF_EXTRACT_TIMEOUT_MS;

  return yield* sharedDocumentParseSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const stdout = yield* Effect.tryPromise({
        try: (signal) =>
          new Promise<string>((resolve, reject) => {
            const existingNodeOptions = environment.NODE_OPTIONS?.trim() ?? "";
            const nodeOptions = existingNodeOptions.includes("--max-old-space-size")
              ? existingNodeOptions
              : `${existingNodeOptions} --max-old-space-size=256`.trim();
            NodeChildProcess.execFile(
              executable,
              [...(isExecutable ? [] : [workerEntryPath]), "__library-extract-pdf", pdfFilePath],
              {
                signal,
                timeout: timeoutMs,
                maxBuffer: 8 * 1024 * 1024,
                encoding: "utf8",
                windowsHide: true,
                env: {
                  ...environment,
                  ELECTRON_RUN_AS_NODE: "1",
                  NODE_OPTIONS: nodeOptions,
                },
              },
              (error, output) => {
                if (error) {
                  reject(error);
                  return;
                }
                resolve(output);
              },
            );
          }),
        catch: (cause) => {
          const exitCode =
            cause instanceof Error && "code" in cause && typeof cause.code === "number"
              ? cause.code
              : undefined;
          const rejected = exitCode === 2;
          return new LibraryPdfWorkerError({
            rejected,
            message: rejected
              ? "PDF document could not be parsed."
              : "Isolated PDF text extraction failed or timed out.",
            cause,
          });
        },
      });

      return yield* decodeExtractedPdf(stdout).pipe(
        Effect.mapError(
          (cause) =>
            new LibraryPdfWorkerError({
              rejected: false,
              message: "Isolated PDF extractor returned invalid output.",
              cause,
            }),
        ),
      );
    }),
  );
});

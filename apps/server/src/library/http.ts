import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  LIBRARY_UPLOAD_METADATA_HEADER,
  LIBRARY_UPLOAD_PDF_PATH,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { LIBRARY_MAX_PDF_UPLOAD_BYTES } from "@t3tools/research-library";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { requestUrl } from "../requestUrl.ts";
import * as LibraryService from "./LibraryService.ts";

const LIBRARY_ITEM_PDF_ROUTE = "/api/library/items/:id/pdf";

function parseByteRange(header: string, size: bigint) {
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? BigInt(match[1]) : null;
  const last = match[2] ? BigInt(match[2]) : null;
  if (first !== null && last !== null && last < first) return null;
  if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n)) {
    return { _tag: "Unsatisfiable" as const };
  }
  const start = first ?? (last! >= size ? 0n : size - last!);
  const end = first === null || last === null || last >= size ? size - 1n : last;
  if (!Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end))) {
    return { _tag: "Unsatisfiable" as const };
  }
  return {
    _tag: "Range" as const,
    offset: start,
    bytesToRead: end - start + 1n,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

function parseQueryTags(raw: string | null): ReadonlyArray<string> | undefined {
  if (raw === null || raw.trim().length === 0) return undefined;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

interface DecodedUploadMetadataHeader {
  readonly fileName?: string | undefined;
  readonly title?: string | undefined;
  readonly note?: string | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}

const MAX_FRAMED_METADATA_BYTES = 1024 * 1024;

function parseMetadataJsonObject(jsonText: string): DecodedUploadMetadataHeader | null {
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const fileName =
      typeof obj.fileName === "string" && obj.fileName.trim().length > 0
        ? obj.fileName.trim()
        : undefined;
    const title =
      typeof obj.title === "string" && obj.title.trim().length > 0 ? obj.title.trim() : undefined;
    const note = typeof obj.note === "string" ? obj.note : undefined;
    const tags = Array.isArray(obj.tags)
      ? obj.tags
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : undefined;
    return { fileName, title, note, tags };
  } catch {
    return null;
  }
}

function parseUploadMetadataHeader(
  raw: string | undefined,
): DecodedUploadMetadataHeader | "framed" | null {
  const trimmed = raw?.trim();
  if (!trimmed) return {};
  if (trimmed === "framed") return "framed";
  if (trimmed.length > 16_384) return null;
  try {
    const jsonText = Buffer.from(trimmed, "base64").toString("utf8");
    return parseMetadataJsonObject(jsonText);
  } catch {
    return null;
  }
}

function decodePathParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export const layerLibraryHttpRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const library = yield* LibraryService.LibraryService;
    const fs = yield* FileSystem.FileSystem;

    /**
     * Authenticates raw research-library HTTP routes using the formal `EnvironmentAuth` pipeline.
     * `authenticateHttpRequest` enforces Cookie/Bearer/DPoP validation AND `rejectMcpClientAudience`,
     * so external `mcp-client` tokens are always rejected outside `/mcp`.
     */
    const authenticateLibraryHttpRoute = Effect.fnUntraced(function* (
      requiredScope: AuthEnvironmentScope,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
          failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          ),
        ),
        Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
          failEnvironmentInternal("internal_error", error),
        ),
      );
      if (!session.scopes.includes(requiredScope)) {
        return yield* failEnvironmentScopeRequired(requiredScope);
      }
      return session;
    });

    const uploadRoute = HttpRouter.add(
      "POST",
      LIBRARY_UPLOAD_PDF_PATH,
      Effect.gen(function* () {
        yield* authenticateLibraryHttpRoute(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url)) {
          return HttpServerResponse.text("Bad Request", { status: 400 });
        }

        // Fast-fail blatantly oversized Content-Length, while STILL enforcing exact streaming byte counts
        // below regardless of whether Content-Length is missing or understated.
        const headerMetadata = parseUploadMetadataHeader(
          request.headers[LIBRARY_UPLOAD_METADATA_HEADER],
        );
        if (headerMetadata === null) {
          return HttpServerResponse.jsonUnsafe(
            {
              error: "validation",
              field: "metadata",
              message: "Invalid x-t3-library-metadata header.",
            },
            { status: 400 },
          );
        }

        const maxWireBytes =
          headerMetadata === "framed"
            ? LIBRARY_MAX_PDF_UPLOAD_BYTES + MAX_FRAMED_METADATA_BYTES + 4
            : LIBRARY_MAX_PDF_UPLOAD_BYTES;
        const rawContentLength = request.headers["content-length"];
        if (rawContentLength !== undefined) {
          const declared = Number(rawContentLength);
          if (Number.isFinite(declared) && declared > maxWireBytes) {
            return HttpServerResponse.jsonUnsafe(
              {
                error: "upload_too_large",
                maxBytes: LIBRARY_MAX_PDF_UPLOAD_BYTES,
                receivedBytes: Math.trunc(declared),
              },
              { status: 413 },
            );
          }
        }

        const chunkQueue = yield* Queue.bounded<Option.Option<Uint8Array>>(4);
        const streamErrorRef: { current: unknown; failed: boolean } = {
          current: null,
          failed: false,
        };

        const producer = yield* request.stream.pipe(
          Stream.runForEach((chunk) => Queue.offer(chunkQueue, Option.some(chunk))),
          Effect.andThen(Queue.offer(chunkQueue, Option.none())),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              streamErrorRef.failed = true;
              streamErrorRef.current = cause;
            }).pipe(Effect.andThen(Queue.offer(chunkQueue, Option.none()).pipe(Effect.ignore))),
          ),
          Effect.forkScoped,
        );

        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

        let resolvedMetadata: DecodedUploadMetadataHeader =
          headerMetadata === "framed" ? {} : headerMetadata;
        let leftoverPdfBytes: Uint8Array | null = null;

        if (headerMetadata === "framed") {
          const framedOutcome = yield* Effect.tryPromise({
            try: async () => {
              const headerBuf = new Uint8Array(4);
              let headerFilled = 0;
              let pendingChunk: Uint8Array | null = null;
              let pendingOffset = 0;

              while (headerFilled < 4) {
                if (pendingChunk === null || pendingOffset >= pendingChunk.byteLength) {
                  const next = await runPromise(Queue.take(chunkQueue));
                  if (Option.isNone(next)) {
                    throw new Error("Truncated framed upload header.");
                  }
                  pendingChunk = next.value;
                  pendingOffset = 0;
                }
                const take = Math.min(4 - headerFilled, pendingChunk.byteLength - pendingOffset);
                headerBuf.set(
                  pendingChunk.subarray(pendingOffset, pendingOffset + take),
                  headerFilled,
                );
                headerFilled += take;
                pendingOffset += take;
              }

              const metaLen = new DataView(headerBuf.buffer, headerBuf.byteOffset, 4).getUint32(
                0,
                false,
              );
              if (metaLen === 0 || metaLen > MAX_FRAMED_METADATA_BYTES) {
                throw new Error("Framed metadata length out of bounds.");
              }

              // Single O(metaLen) allocation filled linearly without quadratic re-copying.
              const metaBuf = new Uint8Array(metaLen);
              let metaFilled = 0;
              while (metaFilled < metaLen) {
                if (pendingChunk === null || pendingOffset >= pendingChunk.byteLength) {
                  const next = await runPromise(Queue.take(chunkQueue));
                  if (Option.isNone(next)) {
                    throw new Error("Truncated framed upload metadata.");
                  }
                  pendingChunk = next.value;
                  pendingOffset = 0;
                }
                const take = Math.min(
                  metaLen - metaFilled,
                  pendingChunk.byteLength - pendingOffset,
                );
                metaBuf.set(pendingChunk.subarray(pendingOffset, pendingOffset + take), metaFilled);
                metaFilled += take;
                pendingOffset += take;
              }

              const metaText = Buffer.from(
                metaBuf.buffer,
                metaBuf.byteOffset,
                metaBuf.byteLength,
              ).toString("utf8");
              const parsed = parseMetadataJsonObject(metaText);
              if (!parsed) {
                throw new Error("Invalid framed upload metadata JSON.");
              }
              const remainder =
                pendingChunk !== null && pendingOffset < pendingChunk.byteLength
                  ? pendingChunk.subarray(pendingOffset)
                  : new Uint8Array(0);
              return { parsed, remainder };
            },
            catch: (cause) =>
              cause instanceof Error ? cause.message : "Invalid framed upload metadata.",
          }).pipe(Effect.result);

          if (framedOutcome._tag === "Failure") {
            yield* Fiber.interrupt(producer).pipe(Effect.ignore);
            return HttpServerResponse.jsonUnsafe(
              {
                error: "validation",
                field: "metadata",
                message: framedOutcome.failure,
              },
              { status: 400 },
            );
          }
          resolvedMetadata = framedOutcome.success.parsed;
          leftoverPdfBytes =
            framedOutcome.success.remainder.byteLength > 0 ? framedOutcome.success.remainder : null;
        }

        const params = url.value.searchParams;
        const fileName =
          resolvedMetadata.fileName ?? (params.get("fileName")?.trim() || "document.pdf");
        const title = resolvedMetadata.title ?? (params.get("title")?.trim() || undefined);
        const note = resolvedMetadata.note ?? params.get("note") ?? undefined;
        const tags = resolvedMetadata.tags ?? parseQueryTags(params.get("tags"));

        const chunks: AsyncIterable<Uint8Array> = {
          async *[Symbol.asyncIterator]() {
            try {
              if (leftoverPdfBytes !== null && leftoverPdfBytes.byteLength > 0) {
                yield leftoverPdfBytes;
                leftoverPdfBytes = null;
              }
              while (true) {
                const next = await runPromise(Queue.take(chunkQueue));
                if (Option.isNone(next)) {
                  if (streamErrorRef.failed) {
                    throw streamErrorRef.current;
                  }
                  return;
                }
                yield next.value;
              }
            } finally {
              void runPromise(Fiber.interrupt(producer).pipe(Effect.ignore));
            }
          },
        };

        const entryResult = yield* library
          .uploadPdfStream({
            fileName,
            chunks,
            title,
            note,
            tags,
            maxBytes: LIBRARY_MAX_PDF_UPLOAD_BYTES,
          })
          .pipe(Effect.result);

        if (entryResult._tag === "Failure") {
          const error = entryResult.failure;
          switch (error._tag) {
            case "LibraryUploadTooLargeError":
              return HttpServerResponse.jsonUnsafe(
                {
                  error: "upload_too_large",
                  maxBytes: error.maxBytes,
                  receivedBytes: error.receivedBytes,
                  message: error.message,
                },
                { status: 413 },
              );
            case "LibraryValidationError":
              return HttpServerResponse.jsonUnsafe(
                {
                  error: "validation",
                  field: error.field,
                  message: error.message,
                },
                { status: 400 },
              );
            case "LibraryDuplicateUrlError":
              return HttpServerResponse.jsonUnsafe(
                {
                  error: "duplicate_url",
                  existingEntryId: error.existingEntryId,
                  message: error.message,
                },
                { status: 409 },
              );
            default:
              return HttpServerResponse.jsonUnsafe(
                {
                  error: "storage_error",
                  message: error.message,
                },
                { status: 500 },
              );
          }
        }

        return HttpServerResponse.jsonUnsafe({ entry: entryResult.success }, { status: 201 });
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
          EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
        }),
      ),
    );

    const handleItemPdf = Effect.fn("library.http.getItemPdf")(
      function* () {
        yield* authenticateLibraryHttpRoute(AuthOrchestrationReadScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = requestUrl(request);
        if (Option.isNone(url)) {
          return HttpServerResponse.text("Bad Request", { status: 400 });
        }

        const match = /^\/api\/library\/items\/([^/]+)\/pdf$/u.exec(url.value.pathname);
        if (!match?.[1]) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const id = decodePathParam(match[1]);
        if (id === null) {
          return HttpServerResponse.text("Bad Request", { status: 400 });
        }

        const resolved = yield* library.resolvePdfBlob(id).pipe(Effect.result);
        if (resolved._tag === "Failure") {
          return HttpServerResponse.text("Internal Server Error", { status: 500 });
        }
        if (resolved.success._tag === "NotFound") {
          return HttpServerResponse.text("PDF not found.", { status: 404 });
        }
        if (resolved.success._tag === "BlobMissing") {
          return HttpServerResponse.text("PDF file is missing on disk.", {
            status: 404,
            headers: {
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
              "x-library-blob-missing": "1",
            },
          });
        }

        const filePath = resolved.success.filePath;
        const stat = yield* fs.stat(filePath).pipe(Effect.orElseSucceed(() => null));
        if (!stat || stat.type !== "File") {
          return HttpServerResponse.text("PDF file is missing on disk.", {
            status: 404,
            headers: {
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
              "x-library-blob-missing": "1",
            },
          });
        }

        const baseHeaders: Record<string, string> = {
          "content-type": "application/pdf",
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
          "content-disposition": "inline",
          "accept-ranges": "bytes",
        };

        if (request.method === "HEAD") {
          return HttpServerResponse.empty({
            status: 200,
            headers: {
              ...baseHeaders,
              "content-length": String(stat.size),
            },
          });
        }

        let status = 200;
        let offset = 0n;
        let bytesToRead: bigint | undefined;

        const rangeHeader = request.headers.range;
        const ifRangeHeader = request.headers["if-range"];
        // Match T3 assetFileResponse contract: fall back to full 200 when If-Range cannot be validated.
        if (rangeHeader !== undefined && ifRangeHeader === undefined) {
          const parsedRange = parseByteRange(rangeHeader, stat.size);
          if (parsedRange?._tag === "Unsatisfiable") {
            return HttpServerResponse.empty({
              status: 416,
              headers: {
                ...baseHeaders,
                "content-range": `bytes */${stat.size}`,
              },
            });
          }
          if (parsedRange?._tag === "Range") {
            status = 206;
            offset = parsedRange.offset;
            bytesToRead = parsedRange.bytesToRead;
            baseHeaders["content-range"] = parsedRange.contentRange;
          }
        }

        return yield* HttpServerResponse.file(filePath, {
          status,
          offset,
          bytesToRead,
          headers: baseHeaders,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.orElseSucceed(() =>
            HttpServerResponse.text("Internal Server Error", { status: 500 }),
          ),
        );
      },
      Effect.catchTags({
        EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
        EnvironmentInternalError: HttpServerRespondable.toResponse,
        EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
      }),
    );

    // Effect HttpRouter serves both GET and HEAD through "GET" routes.
    const itemPdfRoute = HttpRouter.add("GET", LIBRARY_ITEM_PDF_ROUTE, handleItemPdf());

    return Layer.mergeAll(uploadRoute, itemPdfRoute);
  }),
);

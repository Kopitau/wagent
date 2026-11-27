import {
  LIBRARY_UPLOAD_PDF_PATH,
  LibraryUploadPdfResult,
  libraryItemPdfPath,
  type LibraryEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { msg } from "gt-i18n";

import { MarkedText, translatableMessage } from "../errors/translatable.ts";
import { executeConnectedEnvironmentRawHttpFetch } from "./environmentHttpAuth.ts";

const DEFAULT_MAX_PDF_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const decodeUploadResult = Schema.decodeUnknownEffect(LibraryUploadPdfResult);

export class LibraryPdfHttpError extends Schema.TaggedError<LibraryPdfHttpError>()(
  "LibraryPdfHttpError",
  {
    code: Schema.Literals([
      "blob_missing",
      "too_large",
      "unauthorized",
      "forbidden",
      "validation",
      "unavailable",
    ]),
    message: Schema.String,
    i18nMessage: Schema.optionalKey(MarkedText),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isLibraryPdfHttpError = Schema.is(LibraryPdfHttpError);

export interface FetchLibraryPdfBytesInput {
  readonly entryId: string;
  readonly signal?: AbortSignal | undefined;
  readonly reload?: boolean | undefined;
  readonly maxBytes?: number | undefined;
}

export interface UploadLibraryPdfInput {
  readonly fileName: string;
  readonly bytes: Uint8Array | ArrayBuffer;
  readonly title?: string | undefined;
  readonly note?: string | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Fetches an authenticated PDF entry's raw bytes from the target environment
 * using Cookie / Bearer / DPoP credentials with bounded streaming size enforcement.
 */
export const fetchEnvironmentLibraryPdfBytes = Effect.fn("clientRuntime.library.fetchPdfBytes")(
  function* (input: FetchLibraryPdfBytesInput) {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_PDF_DOWNLOAD_BYTES;
    const { response } = yield* executeConnectedEnvironmentRawHttpFetch({
      method: "GET",
      pathAndQuery: libraryItemPdfPath(input.entryId),
      signal: input.signal,
      cache: input.reload ? "reload" : "no-store",
    });

    if (response.headers.get("x-library-blob-missing") === "1") {
      return yield* new LibraryPdfHttpError({
        code: "blob_missing",
        ...translatableMessage(msg("The original PDF file is missing on this environment.")),
      });
    }
    if (response.status === 401) {
      return yield* new LibraryPdfHttpError({
        code: "unauthorized",
        ...translatableMessage(msg("Environment session expired. Reconnect to view this PDF.")),
      });
    }
    if (response.status === 403) {
      return yield* new LibraryPdfHttpError({
        code: "forbidden",
        ...translatableMessage(msg("This session does not have permission to read library PDFs.")),
      });
    }
    if (!response.ok) {
      return yield* new LibraryPdfHttpError({
        code: "unavailable",
        ...translatableMessage(msg("Unable to load PDF from this environment.")),
      });
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return yield* new LibraryPdfHttpError({
        code: "too_large",
        ...translatableMessage(msg("This PDF exceeds the preview size limit.")),
      });
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const reader = response.body?.getReader();
        if (!reader) {
          const fallback = await response.arrayBuffer();
          if (fallback.byteLength > maxBytes) {
            throw new LibraryPdfHttpError({
              code: "too_large",
              ...translatableMessage(msg("This PDF exceeds the preview size limit.")),
            });
          }
          return fallback;
        }
        const chunks: Array<Uint8Array<ArrayBuffer>> = [];
        let received = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) {
              throw new LibraryPdfHttpError({
                code: "too_large",
                ...translatableMessage(msg("This PDF exceeds the preview size limit.")),
              });
            }
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        return new Blob(chunks).arrayBuffer();
      },
      catch: (cause) =>
        isLibraryPdfHttpError(cause)
          ? cause
          : new LibraryPdfHttpError({
              code: "unavailable",
              ...translatableMessage(msg("Failed to download PDF bytes from this environment.")),
              cause,
            }),
    });
  },
);

/**
 * Uploads a raw PDF to `POST /api/library/upload` on the target environment using
 * Cookie / Bearer / DPoP credentials and returns the created `LibraryEntry`.
 */
export const uploadEnvironmentLibraryPdf = Effect.fn("clientRuntime.library.uploadPdf")(function* (
  input: UploadLibraryPdfInput,
): Effect.fn.Return<
  LibraryEntry,
  LibraryPdfHttpError | import("../rpc/http.ts").RemoteEnvironmentAuthFetchError,
  import("../connection/supervisor.ts").EnvironmentSupervisor
> {
  const params = new URLSearchParams();
  params.set("fileName", input.fileName);
  if (input.title?.trim()) params.set("title", input.title.trim());
  if (input.note !== undefined && input.note.length > 0) params.set("note", input.note);
  if (input.tags && input.tags.length > 0) params.set("tags", input.tags.join(","));

  const bodyBytes =
    input.bytes instanceof Uint8Array
      ? new Uint8Array(
          input.bytes.buffer as ArrayBuffer,
          input.bytes.byteOffset,
          input.bytes.byteLength,
        )
      : new Uint8Array(input.bytes);

  const { response } = yield* executeConnectedEnvironmentRawHttpFetch({
    method: "POST",
    pathAndQuery: `${LIBRARY_UPLOAD_PDF_PATH}?${params.toString()}`,
    headers: { "content-type": "application/pdf" },
    body: bodyBytes,
    signal: input.signal,
  });

  if (response.status === 401) {
    return yield* new LibraryPdfHttpError({
      code: "unauthorized",
      ...translatableMessage(msg("Environment session expired. Reconnect to upload PDFs.")),
    });
  }
  if (response.status === 403) {
    return yield* new LibraryPdfHttpError({
      code: "forbidden",
      ...translatableMessage(msg("This session does not have permission to upload PDFs.")),
    });
  }

  const jsonPayload = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: (cause) =>
      new LibraryPdfHttpError({
        code: "unavailable",
        ...translatableMessage(msg("Unexpected response while uploading PDF.")),
        cause,
      }),
  });

  if (!response.ok) {
    const serverMessage =
      typeof jsonPayload === "object" &&
      jsonPayload !== null &&
      "message" in jsonPayload &&
      typeof jsonPayload.message === "string"
        ? jsonPayload.message
        : undefined;
    if (response.status === 413) {
      return yield* new LibraryPdfHttpError({
        code: "too_large",
        ...translatableMessage(msg("PDF file exceeds the 20 MiB upload limit.")),
      });
    }
    if (response.status === 400 || response.status === 409) {
      return yield* new LibraryPdfHttpError({
        code: "validation",
        message: serverMessage ?? "Invalid PDF upload.",
      });
    }
    return yield* new LibraryPdfHttpError({
      code: "unavailable",
      message: serverMessage ?? "Unable to upload PDF to this environment.",
    });
  }

  const decoded = yield* decodeUploadResult(jsonPayload).pipe(
    Effect.mapError(
      (cause) =>
        new LibraryPdfHttpError({
          code: "unavailable",
          ...translatableMessage(msg("Received an invalid library entry from the environment.")),
          cause,
        }),
    ),
  );
  return decoded.entry;
});

// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect domain package uses native Error subclasses mapped at the server boundary.
export class LibraryValidationError extends Error {
  readonly code = "validation" as const;
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "LibraryValidationError";
    this.field = field;
  }
}

// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect domain package uses native Error subclasses mapped at the server boundary.
export class LibraryNotFoundError extends Error {
  readonly code = "not_found" as const;
  readonly entryId: string;

  constructor(entryId: string) {
    super(`Library entry not found: ${entryId}`);
    this.name = "LibraryNotFoundError";
    this.entryId = entryId;
  }
}

// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect domain package uses native Error subclasses mapped at the server boundary.
export class LibraryDuplicateUrlError extends Error {
  readonly code = "duplicate_url" as const;
  readonly url: string;
  readonly existingEntryId: string;

  constructor(url: string, existingEntryId: string) {
    super("An entry with this URL already exists in the library.");
    this.name = "LibraryDuplicateUrlError";
    this.url = url;
    this.existingEntryId = existingEntryId;
  }
}

// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect domain package uses native Error subclasses mapped at the server boundary.
export class LibraryEditConflictError extends Error {
  readonly code = "edit_conflict" as const;
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(entryId: string, expectedRevision: number, currentRevision: number) {
    super(
      `Library entry was modified concurrently (expected revision ${expectedRevision}, current revision ${currentRevision}).`,
    );
    this.name = "LibraryEditConflictError";
    this.entryId = entryId;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect domain package uses native Error subclasses mapped at the server boundary.
export class LibraryUploadTooLargeError extends Error {
  readonly code = "upload_too_large" as const;
  readonly maxBytes: number;
  readonly receivedBytes: number;

  constructor(maxBytes: number, receivedBytes: number) {
    super(`Uploaded PDF exceeded the maximum allowed size of ${maxBytes} bytes.`);
    this.name = "LibraryUploadTooLargeError";
    this.maxBytes = maxBytes;
    this.receivedBytes = receivedBytes;
  }
}

// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect domain package uses native Error subclasses mapped at the server boundary.
export class LibrarySsrfRejectedError extends Error {
  readonly code = "ssrf_rejected" as const;
  readonly host: string;

  constructor(host: string, message?: string) {
    super(message ?? `Refused to fetch non-public or unresolvable host: ${host}`);
    this.name = "LibrarySsrfRejectedError";
    this.host = host;
  }
}

// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect domain package uses native Error subclasses mapped at the server boundary.
export class LibraryPdfExtractionError extends Error {
  readonly code = "pdf_extraction" as const;
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: { readonly retryable?: boolean; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LibraryPdfExtractionError";
    this.retryable = options?.retryable ?? false;
  }
}

export type LibraryDomainError =
  | LibraryValidationError
  | LibraryNotFoundError
  | LibraryDuplicateUrlError
  | LibraryEditConflictError
  | LibraryUploadTooLargeError
  | LibrarySsrfRejectedError
  | LibraryPdfExtractionError;

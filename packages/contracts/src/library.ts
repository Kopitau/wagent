import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LibraryEntryKind = Schema.Literals(["note", "web", "wechat", "file", "pdf"]);
export type LibraryEntryKind = typeof LibraryEntryKind.Type;

export const LibrarySearchMode = Schema.Literals(["browse", "fts5", "substring"]);
export type LibrarySearchMode = typeof LibrarySearchMode.Type;

const LIBRARY_RPC_MAX_TITLE_CHARS = 300;
const LIBRARY_RPC_MAX_URL_CHARS = 2048;
const LIBRARY_RPC_MAX_BODY_CHARS = 240_000;
const LIBRARY_RPC_MAX_NOTE_CHARS = 240_000;
const LIBRARY_RPC_MAX_TAG_CHARS = 64;
const LIBRARY_RPC_MAX_TAGS = 32;
const LIBRARY_RPC_MAX_DRAFT_ITEMS = 5;
const LIBRARY_RPC_MAX_DRAFT_QUESTION_CHARS = 4_000;
const LIBRARY_RPC_MAX_LIST_LIMIT = 100;
const LIBRARY_RPC_MAX_QUERY_CHARS = 500;
const LIBRARY_RPC_MAX_FILENAME_CHARS = 255;

const LibraryEntryId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const LibraryTag = TrimmedNonEmptyString.check(Schema.isMaxLength(LIBRARY_RPC_MAX_TAG_CHARS));
const LibraryTags = Schema.Array(LibraryTag).check(Schema.isMaxLength(LIBRARY_RPC_MAX_TAGS));
const LibraryTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(LIBRARY_RPC_MAX_TITLE_CHARS));
const LibraryUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(LIBRARY_RPC_MAX_URL_CHARS));
const LibraryBody = Schema.String.check(Schema.isMaxLength(LIBRARY_RPC_MAX_BODY_CHARS));
const LibraryNote = Schema.String.check(Schema.isMaxLength(LIBRARY_RPC_MAX_NOTE_CHARS));

export const LibraryEntrySummary = Schema.Struct({
  id: LibraryEntryId,
  kind: LibraryEntryKind,
  title: LibraryTitle,
  url: Schema.NullOr(LibraryUrl),
  tags: LibraryTags,
  snippet: Schema.String,
  notePreview: Schema.String,
  matchedPages: Schema.Array(PositiveInt),
  pageCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  revision: PositiveInt,
});
export type LibraryEntrySummary = typeof LibraryEntrySummary.Type;

export const LibraryEntry = Schema.Struct({
  id: LibraryEntryId,
  kind: LibraryEntryKind,
  title: LibraryTitle,
  url: Schema.NullOr(LibraryUrl),
  body: LibraryBody,
  note: LibraryNote,
  tags: LibraryTags,
  blobSha256: Schema.NullOr(TrimmedNonEmptyString),
  blobBytes: Schema.NullOr(NonNegativeInt),
  pageCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  revision: PositiveInt,
});
export type LibraryEntry = typeof LibraryEntry.Type;

export const LibraryListInput = Schema.Struct({
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(LIBRARY_RPC_MAX_QUERY_CHARS))),
  kind: Schema.optional(LibraryEntryKind),
  tag: Schema.optional(LibraryTag),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: LIBRARY_RPC_MAX_LIST_LIMIT })),
  ),
  offset: Schema.optional(NonNegativeInt),
});
export type LibraryListInput = typeof LibraryListInput.Type;

export const LibraryListResult = Schema.Struct({
  items: Schema.Array(LibraryEntrySummary),
  total: NonNegativeInt,
  hasMore: Schema.Boolean,
  searchMode: LibrarySearchMode,
});
export type LibraryListResult = typeof LibraryListResult.Type;

export const LibraryGetInput = Schema.Struct({
  id: LibraryEntryId,
});
export type LibraryGetInput = typeof LibraryGetInput.Type;

export const LibraryGetResult = Schema.Struct({
  entry: LibraryEntry,
});
export type LibraryGetResult = typeof LibraryGetResult.Type;

export const LibrarySaveInput = Schema.Struct({
  kind: LibraryEntryKind,
  title: LibraryTitle,
  url: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(LIBRARY_RPC_MAX_URL_CHARS))),
  ),
  body: Schema.optional(LibraryBody),
  note: Schema.optional(LibraryNote),
  tags: Schema.optional(LibraryTags),
});
export type LibrarySaveInput = typeof LibrarySaveInput.Type;

export const LibraryImportTextFileInput = Schema.Struct({
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(LIBRARY_RPC_MAX_FILENAME_CHARS)),
  content: LibraryBody,
  title: Schema.optional(LibraryTitle),
  note: Schema.optional(LibraryNote),
  tags: Schema.optional(LibraryTags),
});
export type LibraryImportTextFileInput = typeof LibraryImportTextFileInput.Type;

export const LibraryUpdateInput = Schema.Struct({
  id: LibraryEntryId,
  expectedRevision: PositiveInt,
  title: Schema.optional(LibraryTitle),
  url: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(LIBRARY_RPC_MAX_URL_CHARS))),
  ),
  body: Schema.optional(LibraryBody),
  note: Schema.optional(LibraryNote),
  tags: Schema.optional(LibraryTags),
});
export type LibraryUpdateInput = typeof LibraryUpdateInput.Type;

export const LibraryDeleteInput = Schema.Struct({
  id: LibraryEntryId,
  expectedRevision: PositiveInt,
});
export type LibraryDeleteInput = typeof LibraryDeleteInput.Type;

export const LibraryDeleteResult = Schema.Struct({
  id: LibraryEntryId,
  deletedRevision: PositiveInt,
});
export type LibraryDeleteResult = typeof LibraryDeleteResult.Type;

export const LibraryComposeDraftInput = Schema.Struct({
  entryIds: Schema.Array(LibraryEntryId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(LIBRARY_RPC_MAX_DRAFT_ITEMS),
  ),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(LIBRARY_RPC_MAX_DRAFT_QUESTION_CHARS)),
});
export type LibraryComposeDraftInput = typeof LibraryComposeDraftInput.Type;

export const LibraryComposeDraftResult = Schema.Struct({
  prompt: Schema.String,
  includedEntryIds: Schema.Array(LibraryEntryId),
  truncated: Schema.Boolean,
});
export type LibraryComposeDraftResult = typeof LibraryComposeDraftResult.Type;

export class LibraryValidationError extends Schema.TaggedError<LibraryValidationError>()(
  "LibraryValidationError",
  {
    field: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  },
) {
  override get message(): string {
    return `${this.field}: ${this.reason}`;
  }
}

export class LibraryNotFoundError extends Schema.TaggedError<LibraryNotFoundError>()(
  "LibraryNotFoundError",
  {
    entryId: LibraryEntryId,
  },
) {
  override get message(): string {
    return `Library entry '${this.entryId}' was not found.`;
  }
}

export class LibraryDuplicateUrlError extends Schema.TaggedError<LibraryDuplicateUrlError>()(
  "LibraryDuplicateUrlError",
  {
    existingEntryId: Schema.String.check(Schema.isMaxLength(128)),
  },
) {
  override get message(): string {
    return "An entry with this URL already exists in the library.";
  }
}

export class LibraryEditConflictError extends Schema.TaggedError<LibraryEditConflictError>()(
  "LibraryEditConflictError",
  {
    entryId: LibraryEntryId,
    expectedRevision: PositiveInt,
    currentRevision: PositiveInt,
  },
) {
  override get message(): string {
    return `Library entry '${this.entryId}' was modified concurrently (expected revision ${this.expectedRevision}, current revision ${this.currentRevision}).`;
  }
}

export class LibraryStorageError extends Schema.TaggedError<LibraryStorageError>()(
  "LibraryStorageError",
  {
    operation: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Research library operation '${this.operation}' failed.`;
  }
}

export const isLibraryEditConflictError = Schema.is(LibraryEditConflictError);

export const LibraryRpcError = Schema.Union([
  LibraryValidationError,
  LibraryNotFoundError,
  LibraryDuplicateUrlError,
  LibraryEditConflictError,
  LibraryStorageError,
]);
export type LibraryRpcError = typeof LibraryRpcError.Type;

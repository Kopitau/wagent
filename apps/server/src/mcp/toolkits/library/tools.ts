import {
  LibraryEntryKind,
  LibraryRpcError,
  LibrarySearchMode,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import {
  LIBRARY_MCP_MAX_READ_CHARS,
  LIBRARY_MCP_MAX_SEARCH_LIMIT,
  LIBRARY_PAGE_EXTRACTION_STATUSES,
} from "@t3tools/research-library";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as LibraryService from "../../../library/LibraryService.ts";

const dependencies = [LibraryService.LibraryService];

const LibrarySearchSummary = Schema.Struct({
  id: Schema.String,
  kind: LibraryEntryKind,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  snippet: Schema.String,
  notePreview: Schema.String,
  matchedPages: Schema.Array(PositiveInt),
  pageCount: NonNegativeInt,
  revision: PositiveInt,
});

const LibrarySearchResult = Schema.Struct({
  items: Schema.Array(LibrarySearchSummary),
  total: NonNegativeInt,
  hasMore: Schema.Boolean,
  searchMode: LibrarySearchMode,
});

const LibraryReadPage = Schema.Struct({
  physicalPage: PositiveInt,
  text: Schema.String,
  extractionStatus: Schema.Literals(LIBRARY_PAGE_EXTRACTION_STATUSES),
});

const LibraryReadItemResult = Schema.Struct({
  id: Schema.String,
  kind: LibraryEntryKind,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  note: Schema.String,
  pageCount: NonNegativeInt,
  revision: PositiveInt,
  blobMissing: Schema.Boolean,
  body: Schema.String,
  pages: Schema.Array(LibraryReadPage),
  truncated: Schema.Boolean,
  untrustedContentNotice: Schema.String,
});

const LibrarySearchTool = Tool.make("library_search", {
  description:
    "Search this environment's research library by text query, kind, or tag. Returns lightweight summaries and 1-based matched PDF page numbers.",
  parameters: Schema.Struct({
    query: Schema.optional(
      Schema.String.check(Schema.isMaxLength(500)).annotate({
        description: "Optional full-text query (supports English and CJK).",
      }),
    ),
    kind: Schema.optional(
      LibraryEntryKind.annotate({
        description: "Optional entry kind filter.",
      }),
    ),
    tag: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(64)).annotate({
        description: "Optional exact tag filter.",
      }),
    ),
    limit: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: LIBRARY_MCP_MAX_SEARCH_LIMIT }),
      ).annotate({
        description: "Maximum entries to return (1-20, default 10).",
      }),
    ),
    offset: Schema.optional(
      NonNegativeInt.annotate({
        description: "Pagination offset.",
      }),
    ),
  }),
  success: LibrarySearchResult,
  failure: LibraryRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Search research library")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LibraryReadItemTool = Tool.make("library_read_item", {
  description:
    "Read metadata, personal notes, and bounded body or 1-based PDF physical page text from a research library entry.",
  parameters: Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description: "Library entry ID from library_search or a composed draft.",
    }),
    pageStart: Schema.optional(
      PositiveInt.annotate({
        description: "Optional 1-based first PDF physical page to read.",
      }),
    ),
    pageEnd: Schema.optional(
      PositiveInt.annotate({
        description: "Optional 1-based last PDF physical page to read.",
      }),
    ),
    maxChars: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: 256, maximum: LIBRARY_MCP_MAX_READ_CHARS }),
      ).annotate({
        description: "Maximum total characters to return (256-24000).",
      }),
    ),
  }),
  success: LibraryReadItemResult,
  failure: LibraryRpcError,
  dependencies,
})
  .annotate(Tool.Title, "Read research library item")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const LibraryToolkit = Toolkit.make(LibrarySearchTool, LibraryReadItemTool);

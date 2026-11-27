import {
  LibraryEntryKind,
  LibraryRpcError,
  LibrarySearchMode,
  NonNegativeInt,
  OrchestratorMcpFailure,
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
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const readDependencies = [LibraryService.LibraryService];
const writeDependencies = [
  LibraryService.LibraryService,
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

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

const LibraryReadingNoteMcpItem = Schema.Struct({
  physicalPage: PositiveInt,
  anchor: Schema.String,
  quote: Schema.String,
  note: Schema.String,
  marked: Schema.Boolean,
  highlighted: Schema.Boolean,
  wkbKind: Schema.String,
  cardSummary: Schema.NullOr(Schema.String),
});

const LibraryGetReadingNotesResult = Schema.Struct({
  entryId: Schema.String,
  title: Schema.String,
  entryNote: Schema.String,
  items: Schema.Array(LibraryReadingNoteMcpItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
  totalItems: NonNegativeInt,
  truncated: Schema.Boolean,
  untrustedContentNotice: Schema.String,
});

const LibraryAppendNoteResult = Schema.Struct({
  entryId: Schema.String,
  revision: PositiveInt,
  deduplicated: Schema.Boolean,
});

const LibrarySaveUrlResult = Schema.Struct({
  entryId: Schema.String,
  kind: LibraryEntryKind,
  title: Schema.String,
  url: Schema.NullOr(Schema.String),
  fetched: Schema.Boolean,
  fallbackReason: Schema.NullOr(Schema.String),
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
  dependencies: readDependencies,
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
  dependencies: readDependencies,
})
  .annotate(Tool.Title, "Read research library item")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LibraryGetReadingNotesTool = Tool.make("library_get_reading_notes", {
  description:
    "Read bounded DeepRead paragraph notes, muddiest-point markers, highlights, and optional card summaries for a library entry.",
  parameters: Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description: "Library entry ID.",
    }),
    cursor: Schema.optional(
      NonNegativeInt.annotate({
        description: "Pagination cursor from previous call.",
      }),
    ),
    maxChars: Schema.optional(
      Schema.Int.check(
        Schema.isBetween({ minimum: 256, maximum: LIBRARY_MCP_MAX_READ_CHARS }),
      ).annotate({
        description: "Maximum total characters to return (256-24000).",
      }),
    ),
    includeCards: Schema.optional(
      Schema.Boolean.annotate({
        description: "Include AI card summaries alongside personal notes (default true).",
      }),
    ),
  }),
  success: LibraryGetReadingNotesResult,
  failure: LibraryRpcError,
  dependencies: readDependencies,
})
  .annotate(Tool.Title, "Read DeepRead paragraph notes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LibraryAppendNoteTool = Tool.make("library_append_note", {
  description:
    "Atomically and idempotently append a structured note to a research library entry. Requires a unique idempotencyKey.",
  parameters: Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description: "Library entry ID.",
    }),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)).annotate({
      description: "Note text to append.",
    }),
    idempotencyKey: TrimmedNonEmptyString.check(Schema.isMaxLength(128)).annotate({
      description: "Unique caller-generated key preventing duplicate appends on retries.",
    }),
    expectedRevision: Schema.optional(
      PositiveInt.annotate({
        description: "Optional optimistic-lock revision guard.",
      }),
    ),
  }),
  success: LibraryAppendNoteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: writeDependencies,
})
  .annotate(Tool.Title, "Append note to library entry")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const LibrarySaveUrlTool = Tool.make("library_save_url", {
  description:
    "Fetch and save a public webpage or WeChat article URL into this environment's research library with SSRF protection and URL deduplication.",
  parameters: Schema.Struct({
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)).annotate({
      description: "Public HTTP/HTTPS article URL.",
    }),
    title: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(300)).annotate({
        description: "Optional title override.",
      }),
    ),
    note: Schema.optional(
      Schema.String.check(Schema.isMaxLength(16_000)).annotate({
        description: "Optional personal note.",
      }),
    ),
    tags: Schema.optional(
      Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64)))
        .check(Schema.isMaxLength(32))
        .annotate({ description: "Optional tags." }),
    ),
  }),
  success: LibrarySaveUrlResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: writeDependencies,
})
  .annotate(Tool.Title, "Save URL to research library")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const LibraryToolkit = Toolkit.make(
  LibrarySearchTool,
  LibraryReadItemTool,
  LibraryGetReadingNotesTool,
  LibraryAppendNoteTool,
  LibrarySaveUrlTool,
);

import { OrchestratorMcpFailure, type LibraryRpcError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LibraryService from "../../../library/LibraryService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { LibraryToolkit } from "./tools.ts";

function mapLibraryWriteFailure(error: LibraryRpcError): OrchestratorMcpFailure {
  switch (error._tag) {
    case "LibraryValidationError":
    case "LibraryNotFoundError":
    case "LibraryDuplicateUrlError":
    case "LibraryEditConflictError":
    case "LibrarySsrfRejectedError":
    case "LibraryUploadTooLargeError":
      return new OrchestratorMcpFailure({
        code: "invalid_request",
        message: error.message,
      });
    default:
      return new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: error.message,
      });
  }
}

export const layer = McpToolAccess.toLayer(
  LibraryToolkit,
  Effect.gen(function* () {
    const library = yield* LibraryService.LibraryService;

    return {
      library_search: McpToolAccess.reads((input) =>
        library
          .list({
            ...(input.query === undefined ? {} : { query: input.query }),
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.tag === undefined ? {} : { tag: input.tag }),
            limit: input.limit ?? 10,
            ...(input.offset === undefined ? {} : { offset: input.offset }),
          })
          .pipe(
            Effect.map((result) => ({
              items: result.items.map((item) => ({
                id: item.id,
                kind: item.kind,
                title: item.title,
                url: item.url,
                tags: item.tags,
                snippet: item.snippet,
                notePreview: item.notePreview,
                matchedPages: item.matchedPages,
                pageCount: item.pageCount,
                revision: item.revision,
              })),
              total: result.total,
              hasMore: result.hasMore,
              searchMode: result.searchMode,
            })),
          ),
      ),
      library_read_item: McpToolAccess.reads((input) =>
        library.readItemForMcp({
          id: input.id,
          ...(input.pageStart === undefined ? {} : { pageStart: input.pageStart }),
          ...(input.pageEnd === undefined ? {} : { pageEnd: input.pageEnd }),
          ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
        }),
      ),
      library_get_reading_notes: McpToolAccess.reads((input) =>
        library.getReadingNotesForMcp({
          id: input.id,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
          ...(input.includeCards === undefined ? {} : { includeCards: input.includeCards }),
        }),
      ),
      library_append_note: McpToolAccess.writes((input) =>
        library
          .appendNoteIdempotent({
            entryId: input.id,
            text: input.text,
            idempotencyKey: input.idempotencyKey,
            ...(input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
          })
          .pipe(
            Effect.map((result) => ({
              entryId: result.entry.id,
              revision: result.entry.revision,
              deduplicated: result.deduplicated,
            })),
            Effect.mapError(mapLibraryWriteFailure),
          ),
      ),
      library_save_url: McpToolAccess.writes((input) =>
        library
          .fetchUrl({
            url: input.url,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.note === undefined ? {} : { note: input.note }),
            ...(input.tags === undefined ? {} : { tags: input.tags }),
          })
          .pipe(
            Effect.map((result) => ({
              entryId: result.entry.id,
              kind: result.entry.kind,
              title: result.entry.title,
              url: result.entry.url,
              fetched: result.fetched,
              fallbackReason: result.fallbackReason,
            })),
            Effect.mapError(mapLibraryWriteFailure),
          ),
      ),
      library_run_feed: McpToolAccess.writes((input) =>
        library
          .runFeedNow({
            id: input.feedId,
          })
          .pipe(
            Effect.map((result) => ({
              feedId: result.feed.id,
              skippedPaused: result.skippedPaused,
              fetchedCount: result.fetchedCount,
              importedCount: result.importedCount,
              deduplicatedCount: result.deduplicatedCount,
              summarizedCount: result.summarizedCount,
              budgetExhaustedCount: result.budgetExhaustedCount,
              importedEntryIds: result.importedEntryIds,
              errors: result.errors,
            })),
            Effect.mapError(mapLibraryWriteFailure),
          ),
      ),
      library_work_harvest: McpToolAccess.writesFullAccess(
        "harvest local git commits into wkb work",
        (input) =>
          library
            .runWorkHarvest({
              ...(input.project !== undefined ? { project: input.project } : {}),
              ...(input.report !== undefined ? { report: input.report } : {}),
              ...(input.files !== undefined ? { files: input.files } : {}),
              ...(input.commits !== undefined ? { commits: input.commits } : {}),
              ...(input.summary !== undefined ? { summary: input.summary } : {}),
              ...(input.projectBlurb !== undefined ? { projectBlurb: input.projectBlurb } : {}),
            })
            .pipe(Effect.mapError(mapLibraryWriteFailure)),
      ),
    };
  }),
);

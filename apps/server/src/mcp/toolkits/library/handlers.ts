import * as Effect from "effect/Effect";

import * as LibraryService from "../../../library/LibraryService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { LibraryToolkit } from "./tools.ts";

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
    };
  }),
);

export const LIBRARY_ENTRY_KINDS = ["note", "web", "wechat", "file", "pdf"] as const;
export type LibraryEntryKind = (typeof LIBRARY_ENTRY_KINDS)[number];

export const LIBRARY_PAGE_EXTRACTION_STATUSES = [
  "ok",
  "empty_scan",
  "truncated",
  "skipped",
] as const;
export type LibraryPageExtractionStatus = (typeof LIBRARY_PAGE_EXTRACTION_STATUSES)[number];

export const LIBRARY_SEARCH_MODES = ["browse", "fts5", "substring"] as const;
export type LibrarySearchMode = (typeof LIBRARY_SEARCH_MODES)[number];

export const LIBRARY_MAX_TITLE_CHARS = 300;
export const LIBRARY_MAX_URL_CHARS = 2048;
export const LIBRARY_MAX_BODY_CHARS = 240_000;
export const LIBRARY_MAX_NOTE_CHARS = 240_000;
export const LIBRARY_MAX_TAG_CHARS = 64;
export const LIBRARY_MAX_TAGS = 32;
export const LIBRARY_MAX_DRAFT_ITEMS = 5;
export const LIBRARY_MAX_DRAFT_QUESTION_CHARS = 4_000;
export const LIBRARY_MAX_DRAFT_CHARS = 24_000;
export const LIBRARY_MAX_LIST_LIMIT = 100;
export const LIBRARY_DEFAULT_LIST_LIMIT = 30;
export const LIBRARY_SNIPPET_MAX_CHARS = 240;
export const LIBRARY_MAX_QUERY_CHARS = 500;
export const LIBRARY_MAX_FILENAME_CHARS = 255;

export interface LibraryEntryPage {
  readonly physicalPage: number;
  readonly text: string;
  readonly extractionStatus: LibraryPageExtractionStatus;
}

export interface LibraryEntrySummary {
  readonly id: string;
  readonly kind: LibraryEntryKind;
  readonly title: string;
  readonly url: string | null;
  readonly tags: ReadonlyArray<string>;
  readonly snippet: string;
  readonly notePreview: string;
  readonly matchedPages: ReadonlyArray<number>;
  readonly pageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface LibraryEntry {
  readonly id: string;
  readonly kind: LibraryEntryKind;
  readonly title: string;
  readonly url: string | null;
  readonly body: string;
  readonly note: string;
  readonly tags: ReadonlyArray<string>;
  readonly blobSha256: string | null;
  readonly blobBytes: number | null;
  readonly pageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface SaveLibraryEntryInput {
  readonly kind: LibraryEntryKind;
  readonly title: string;
  readonly url?: string | null | undefined;
  readonly body?: string | undefined;
  readonly note?: string | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
  readonly pages?: ReadonlyArray<LibraryEntryPage> | undefined;
  readonly pageCount?: number | undefined;
  readonly blobSha256?: string | null | undefined;
  readonly blobBytes?: number | null | undefined;
}

export interface ImportTextFileInput {
  readonly fileName: string;
  readonly content: string;
  readonly title?: string | undefined;
  readonly note?: string | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}

export interface UpdateLibraryEntryInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly title?: string | undefined;
  readonly url?: string | null | undefined;
  readonly body?: string | undefined;
  readonly note?: string | undefined;
  readonly tags?: ReadonlyArray<string> | undefined;
}

export interface DeleteLibraryEntryInput {
  readonly id: string;
  readonly expectedRevision: number;
}

export interface DeleteLibraryEntryResult {
  readonly id: string;
  readonly deletedRevision: number;
}

export interface ListLibraryEntriesInput {
  readonly query?: string | undefined;
  readonly kind?: LibraryEntryKind | undefined;
  readonly tag?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ListLibraryEntriesResult {
  readonly items: ReadonlyArray<LibraryEntrySummary>;
  readonly total: number;
  readonly hasMore: boolean;
  readonly searchMode: LibrarySearchMode;
}

export interface ComposeLibraryDraftEntry {
  readonly id: string;
  readonly kind: LibraryEntryKind;
  readonly title: string;
  readonly url: string | null;
  readonly body: string;
  readonly note: string;
  readonly tags: ReadonlyArray<string>;
  readonly pageCount: number;
  readonly revision: number;
  readonly pages?: ReadonlyArray<LibraryEntryPage> | undefined;
}

export interface ComposeLibraryDraftInput {
  readonly environmentId: string;
  readonly question: string;
  readonly entries: ReadonlyArray<ComposeLibraryDraftEntry>;
  readonly maxTotalChars?: number | undefined;
}

export interface ComposeLibraryDraftResult {
  readonly prompt: string;
  readonly includedEntryIds: ReadonlyArray<string>;
  readonly truncated: boolean;
}

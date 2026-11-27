import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";

export const LibraryEntryKind = Schema.Literals([
  "note",
  "web",
  "wechat",
  "file",
  "pdf",
  "video",
  "epub",
]);
export type LibraryEntryKind = typeof LibraryEntryKind.Type;

export const LIBRARY_UPLOAD_PDF_PATH = "/api/library/upload";
export const LIBRARY_UPLOAD_METADATA_HEADER = "x-t3-library-metadata";
export const libraryItemPdfPath = (id: string): string =>
  `/api/library/items/${encodeURIComponent(id)}/pdf`;

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
  blobMissing: Schema.Boolean,
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
  maxBodyChars: Schema.optional(PositiveInt),
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

export const LibraryFetchUrlInput = Schema.Struct({
  url: LibraryUrl,
  title: Schema.optional(LibraryTitle),
  note: Schema.optional(LibraryNote),
  tags: Schema.optional(LibraryTags),
  allowFallback: Schema.optional(Schema.Boolean),
});
export type LibraryFetchUrlInput = typeof LibraryFetchUrlInput.Type;

export const LibraryFetchUrlResult = Schema.Struct({
  entry: LibraryEntry,
  fetched: Schema.Boolean,
  fallbackReason: Schema.NullOr(Schema.String),
});
export type LibraryFetchUrlResult = typeof LibraryFetchUrlResult.Type;

export const LibraryWkbMode = Schema.Literals(["local", "remote", "dual", "unavailable"]);
export type LibraryWkbMode = typeof LibraryWkbMode.Type;

export const LibraryWkbStatusResult = Schema.Struct({
  available: Schema.Boolean,
  syncAvailable: Schema.optional(Schema.Boolean),
  mode: LibraryWkbMode,
  remoteUrl: Schema.NullOr(LibraryUrl),
});
export type LibraryWkbStatusResult = typeof LibraryWkbStatusResult.Type;

export const LibraryImportFromWkbInput = Schema.Struct({
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(LIBRARY_RPC_MAX_URL_CHARS)),
  generatePdf: Schema.optional(Schema.Boolean),
  note: Schema.optional(LibraryNote),
  tags: Schema.optional(LibraryTags),
});
export type LibraryImportFromWkbInput = typeof LibraryImportFromWkbInput.Type;

export const LibraryImportFromWkbResult = Schema.Struct({
  entry: LibraryEntry,
  warnings: Schema.Array(Schema.String),
});
export type LibraryImportFromWkbResult = typeof LibraryImportFromWkbResult.Type;

export const LibraryUploadPdfResult = Schema.Struct({
  entry: LibraryEntry,
});
export type LibraryUploadPdfResult = typeof LibraryUploadPdfResult.Type;

export const LibraryReadingModelRoute = Schema.Literals(["direct_api", "cli_subscription"]);
export type LibraryReadingModelRoute = typeof LibraryReadingModelRoute.Type;

export const LibraryReadingAiActionKind = Schema.Literals([
  "analyze_paragraph",
  "summary5",
  "quiz5",
  "guide",
  "figure_explain",
  "ask_question",
]);
export type LibraryReadingAiActionKind = typeof LibraryReadingAiActionKind.Type;

export const LibraryEntryPageContract = Schema.Struct({
  physicalPage: PositiveInt,
  text: Schema.String,
  extractionStatus: Schema.Literals(["ok", "empty_scan", "truncated", "skipped"]),
});
export type LibraryEntryPageContract = typeof LibraryEntryPageContract.Type;

export const LibraryReadingParagraphContract = Schema.Struct({
  entryId: LibraryEntryId,
  physicalPage: PositiveInt,
  anchor: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  blobSha256: Schema.NullOr(TrimmedNonEmptyString),
  anchorAlgoVersion: PositiveInt,
  quote: Schema.String.check(Schema.isMaxLength(8_000)),
  note: LibraryNote,
  marked: Schema.Boolean,
  highlighted: Schema.Boolean,
  highlightColor: Schema.String.check(Schema.isMaxLength(32)),
  wkbKind: Schema.String.check(Schema.isMaxLength(16)),
  hidden: Schema.Boolean,
  mergedInto: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  analysisJson: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type LibraryReadingParagraphContract = typeof LibraryReadingParagraphContract.Type;

export const LibraryReadingQuestionContract = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  entryId: LibraryEntryId,
  physicalPage: PositiveInt,
  anchor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  question: Schema.String.check(Schema.isMaxLength(4_000)),
  selfAnswer: Schema.String.check(Schema.isMaxLength(16_000)),
  answer: Schema.String.check(Schema.isMaxLength(48_000)),
  sourcesJson: Schema.String,
  modelId: Schema.String.check(Schema.isMaxLength(200)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LibraryReadingQuestionContract = typeof LibraryReadingQuestionContract.Type;

export const LibraryReadingInsightContract = Schema.Struct({
  entryId: LibraryEntryId,
  kind: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  payloadJson: Schema.String,
  modelId: Schema.String.check(Schema.isMaxLength(200)),
  updatedAt: IsoDateTime,
});
export type LibraryReadingInsightContract = typeof LibraryReadingInsightContract.Type;

export const LibraryGetReadingStateInput = Schema.Struct({
  entryId: LibraryEntryId,
  includePages: Schema.optional(Schema.Boolean),
});
export type LibraryGetReadingStateInput = typeof LibraryGetReadingStateInput.Type;

export const LibraryReadingStateResult = Schema.Struct({
  entryId: LibraryEntryId,
  physicalPage: PositiveInt,
  paragraphs: Schema.Array(LibraryReadingParagraphContract),
  questions: Schema.Array(LibraryReadingQuestionContract),
  insights: Schema.Array(LibraryReadingInsightContract),
  preferences: Schema.Record(Schema.String, Schema.String),
  pages: Schema.Array(LibraryEntryPageContract),
});
export type LibraryReadingStateResult = typeof LibraryReadingStateResult.Type;

export const LibrarySetReadingPositionInput = Schema.Struct({
  entryId: LibraryEntryId,
  physicalPage: PositiveInt,
});
export type LibrarySetReadingPositionInput = typeof LibrarySetReadingPositionInput.Type;

export const LibrarySetReadingPositionResult = Schema.Struct({
  physicalPage: PositiveInt,
});
export type LibrarySetReadingPositionResult = typeof LibrarySetReadingPositionResult.Type;

export const LibraryUpsertReadingParagraphInput = Schema.Struct({
  entryId: LibraryEntryId,
  physicalPage: PositiveInt,
  anchor: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  blobSha256: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  anchorAlgoVersion: Schema.optional(PositiveInt),
  quote: Schema.String.check(Schema.isMaxLength(8_000)),
  note: Schema.optional(LibraryNote),
  marked: Schema.optional(Schema.Boolean),
  highlighted: Schema.optional(Schema.Boolean),
  highlightColor: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
  wkbKind: Schema.optional(Schema.String.check(Schema.isMaxLength(16))),
  hidden: Schema.optional(Schema.Boolean),
  mergedInto: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)))),
  analysisJson: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(120_000)))),
});
export type LibraryUpsertReadingParagraphInput = typeof LibraryUpsertReadingParagraphInput.Type;

export const LibraryUpsertReadingQuestionInput = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  entryId: LibraryEntryId,
  physicalPage: PositiveInt,
  anchor: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)))),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  selfAnswer: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  answer: Schema.optional(Schema.String.check(Schema.isMaxLength(48_000))),
  sourcesJson: Schema.optional(Schema.String.check(Schema.isMaxLength(32_000))),
  modelId: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type LibraryUpsertReadingQuestionInput = typeof LibraryUpsertReadingQuestionInput.Type;

export const LibraryDeleteReadingQuestionInput = Schema.Struct({
  entryId: LibraryEntryId,
  questionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type LibraryDeleteReadingQuestionInput = typeof LibraryDeleteReadingQuestionInput.Type;

export const LibraryDeleteReadingQuestionResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type LibraryDeleteReadingQuestionResult = typeof LibraryDeleteReadingQuestionResult.Type;

export const LibraryUpsertReadingInsightInput = Schema.Struct({
  entryId: LibraryEntryId,
  kind: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  payloadJson: Schema.String.check(Schema.isMaxLength(240_000)),
  modelId: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type LibraryUpsertReadingInsightInput = typeof LibraryUpsertReadingInsightInput.Type;

export const LibrarySetReadingPreferenceInput = Schema.Struct({
  scopeKey: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  valueJson: Schema.String.check(Schema.isMaxLength(32_000)),
});
export type LibrarySetReadingPreferenceInput = typeof LibrarySetReadingPreferenceInput.Type;

export const LibraryReadingModelOption = Schema.Struct({
  instanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  providerLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  route: LibraryReadingModelRoute,
});
export type LibraryReadingModelOption = typeof LibraryReadingModelOption.Type;

export const LibraryListReadingModelsResult = Schema.Struct({
  models: Schema.Array(LibraryReadingModelOption),
});
export type LibraryListReadingModelsResult = typeof LibraryListReadingModelsResult.Type;

export const LibraryRunReadingAiActionInput = Schema.Struct({
  entryId: LibraryEntryId,
  action: LibraryReadingAiActionKind,
  physicalPage: Schema.optional(PositiveInt),
  anchor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  quote: Schema.optional(Schema.String.check(Schema.isMaxLength(8_000))),
  figureLabel: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  question: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))),
  questionId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  instanceId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  strictModel: Schema.optional(Schema.Boolean),
});
export type LibraryRunReadingAiActionInput = typeof LibraryRunReadingAiActionInput.Type;

export const LibraryRunReadingAiActionResult = Schema.Struct({
  action: LibraryReadingAiActionKind,
  route: LibraryReadingModelRoute,
  modelId: Schema.String.check(Schema.isMaxLength(240)),
  payloadJson: Schema.String,
  paragraph: Schema.optional(LibraryReadingParagraphContract),
  question: Schema.optional(LibraryReadingQuestionContract),
  insight: Schema.optional(LibraryReadingInsightContract),
});
export type LibraryRunReadingAiActionResult = typeof LibraryRunReadingAiActionResult.Type;

export const LibraryImportGuideInput = Schema.Struct({
  entryId: LibraryEntryId,
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(240_000)),
});
export type LibraryImportGuideInput = typeof LibraryImportGuideInput.Type;

export const LibrarySyncWkbAnnotationsInput = Schema.Struct({
  entryId: LibraryEntryId,
  sourceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type LibrarySyncWkbAnnotationsInput = typeof LibrarySyncWkbAnnotationsInput.Type;

export const LibrarySyncWkbAnnotationsResult = Schema.Struct({
  mode: Schema.Literals(["remote", "local"]),
  summary: Schema.String,
  syncedCount: NonNegativeInt,
  queued: Schema.optional(Schema.Boolean),
});
export type LibrarySyncWkbAnnotationsResult = typeof LibrarySyncWkbAnnotationsResult.Type;

export const LibrarySubmitToWkbInput = Schema.Struct({
  entryId: LibraryEntryId,
  note: Schema.optional(LibraryNote),
});
export type LibrarySubmitToWkbInput = typeof LibrarySubmitToWkbInput.Type;

export const LibrarySubmitToWkbResult = Schema.Struct({
  mode: Schema.Literals(["remote", "local"]),
  summary: Schema.String,
  queued: Schema.optional(Schema.Boolean),
});
export type LibrarySubmitToWkbResult = typeof LibrarySubmitToWkbResult.Type;

export const LibraryImaConfigView = Schema.Struct({
  enabled: Schema.Boolean,
  baseUrl: Schema.String.check(Schema.isMaxLength(2048)),
  knowledgeBaseId: Schema.String.check(Schema.isMaxLength(256)),
  hasApiKey: Schema.Boolean,
});
export type LibraryImaConfigView = typeof LibraryImaConfigView.Type;

export const LibraryUpdateImaConfigInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  baseUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  knowledgeBaseId: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  apiKey: Schema.optional(Schema.NullOr(SettingsSecretValue)),
});
export type LibraryUpdateImaConfigInput = typeof LibraryUpdateImaConfigInput.Type;

export const LibraryImaSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type LibraryImaSearchInput = typeof LibraryImaSearchInput.Type;

export const LibraryImaSearchHit = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  url: Schema.NullOr(Schema.String),
  score: Schema.NullOr(Schema.Number),
});
export type LibraryImaSearchHit = typeof LibraryImaSearchHit.Type;

export const LibraryImaSearchResult = Schema.Struct({
  hits: Schema.Array(LibraryImaSearchHit),
});
export type LibraryImaSearchResult = typeof LibraryImaSearchResult.Type;

export const LibraryFeedKind = Schema.Literals(["rss", "arxiv"]);
export type LibraryFeedKind = typeof LibraryFeedKind.Type;

const LibraryFeedId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const LibraryFeedContract = Schema.Struct({
  id: LibraryFeedId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: LibraryFeedKind,
  url: LibraryUrl,
  tags: LibraryTags,
  enabled: Schema.Boolean,
  intervalMinutes: Schema.Int.check(Schema.isBetween({ minimum: 15, maximum: 10_080 })),
  maxItemsPerRun: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  autoSummarize: Schema.Boolean,
  aiInstanceId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  aiModel: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  dailyAiBudget: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastStatus: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(400))),
  lastImportedCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LibraryFeedContract = typeof LibraryFeedContract.Type;

export const LibraryListFeedsResult = Schema.Struct({
  feeds: Schema.Array(LibraryFeedContract),
  dailyAiUsed: NonNegativeInt,
});
export type LibraryListFeedsResult = typeof LibraryListFeedsResult.Type;

export const LibraryUpsertFeedInput = Schema.Struct({
  id: Schema.optional(LibraryFeedId),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: LibraryFeedKind,
  url: LibraryUrl,
  tags: Schema.optional(LibraryTags),
  enabled: Schema.optional(Schema.Boolean),
  intervalMinutes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 15, maximum: 10_080 })),
  ),
  maxItemsPerRun: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  autoSummarize: Schema.optional(Schema.Boolean),
  aiInstanceId: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  ),
  aiModel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200)))),
  dailyAiBudget: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
});
export type LibraryUpsertFeedInput = typeof LibraryUpsertFeedInput.Type;

export const LibrarySetFeedEnabledInput = Schema.Struct({
  id: LibraryFeedId,
  enabled: Schema.Boolean,
});
export type LibrarySetFeedEnabledInput = typeof LibrarySetFeedEnabledInput.Type;

export const LibraryDeleteFeedInput = Schema.Struct({
  id: LibraryFeedId,
});
export type LibraryDeleteFeedInput = typeof LibraryDeleteFeedInput.Type;

export const LibraryDeleteFeedResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type LibraryDeleteFeedResult = typeof LibraryDeleteFeedResult.Type;

export const LibraryRunFeedNowInput = Schema.Struct({
  id: LibraryFeedId,
});
export type LibraryRunFeedNowInput = typeof LibraryRunFeedNowInput.Type;

export const LibraryRunFeedNowResult = Schema.Struct({
  feed: LibraryFeedContract,
  skippedPaused: Schema.Boolean,
  fetchedCount: NonNegativeInt,
  importedCount: NonNegativeInt,
  deduplicatedCount: NonNegativeInt,
  summarizedCount: NonNegativeInt,
  budgetExhaustedCount: NonNegativeInt,
  importedEntryIds: Schema.Array(LibraryEntryId),
  errors: Schema.Array(Schema.String),
});
export type LibraryRunFeedNowResult = typeof LibraryRunFeedNowResult.Type;

export const LibraryWorkFileInput = Schema.Struct({
  name: Schema.Literals(["overview", "decisions", "pitfalls", "timeline"]),
  content: Schema.String.check(Schema.isMaxLength(60_000)),
  base: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});

export const LibraryRunWorkHarvestInput = Schema.Struct({
  project: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  report: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32_000))),
  files: Schema.optional(Schema.Array(LibraryWorkFileInput).check(Schema.isMaxLength(4))),
  projectBlurb: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  commits: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type LibraryRunWorkHarvestInput = typeof LibraryRunWorkHarvestInput.Type;

export const LibraryRunWorkHarvestResult = Schema.Struct({
  mode: Schema.Literals(["remote", "local"]),
  project: Schema.NullOr(Schema.String),
  summary: Schema.String,
});
export type LibraryRunWorkHarvestResult = typeof LibraryRunWorkHarvestResult.Type;

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

export class LibrarySsrfRejectedError extends Schema.TaggedError<LibrarySsrfRejectedError>()(
  "LibrarySsrfRejectedError",
  {
    host: Schema.String.check(Schema.isMaxLength(255)),
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class LibraryUploadTooLargeError extends Schema.TaggedError<LibraryUploadTooLargeError>()(
  "LibraryUploadTooLargeError",
  {
    maxBytes: NonNegativeInt,
    receivedBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Uploaded PDF exceeded the maximum size of ${this.maxBytes} bytes.`;
  }
}

export class LibraryWkbError extends Schema.TaggedError<LibraryWkbError>()("LibraryWkbError", {
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
}) {
  override get message(): string {
    return this.reason;
  }
}

export class LibraryAiError extends Schema.TaggedError<LibraryAiError>()("LibraryAiError", {
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
}) {
  override get message(): string {
    return this.reason;
  }
}

export class LibraryImaError extends Schema.TaggedError<LibraryImaError>()("LibraryImaError", {
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
}) {
  override get message(): string {
    return this.reason;
  }
}

export const isLibraryEditConflictError = Schema.is(LibraryEditConflictError);

export const LibraryRpcError = Schema.Union([
  LibraryValidationError,
  LibraryNotFoundError,
  LibraryDuplicateUrlError,
  LibraryEditConflictError,
  LibraryStorageError,
  LibrarySsrfRejectedError,
  LibraryUploadTooLargeError,
  LibraryWkbError,
  LibraryAiError,
  LibraryImaError,
]);
export type LibraryRpcError = typeof LibraryRpcError.Type;

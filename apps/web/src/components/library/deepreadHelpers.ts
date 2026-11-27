import type {
  LibraryEntry,
  LibraryEntryPageContract,
  LibraryReadingInsightContract,
  LibraryReadingParagraphContract,
} from "@t3tools/contracts";
import {
  computeParagraphAnchor,
  extractFigures,
  extractReferences,
  extractSections,
  formatBlockKey,
  formatBlockLabel,
  PARAGRAPH_ROLE_STYLES,
  parseBlockKey,
  type DeepReadGuide,
  type HighlightDensity,
  type PaperFigureItem,
  type PaperParagraphBlock,
  type ParagraphRole,
  type RailLayoutMode,
  type ReadingDepthMode,
  type ReadingSection,
  type ReferenceEntry,
} from "@t3tools/research-library/reader";

export interface ParsedParagraphAnalysis {
  readonly role: ParagraphRole;
  readonly importance: number;
  readonly summary: string;
  readonly points: ReadonlyArray<string>;
  readonly explanation: string;
  readonly translation: string;
  readonly keySentence?: string | undefined;
}

export interface ParsedSummary5 {
  readonly problem: string;
  readonly method: string;
  readonly findings: string;
  readonly evidence: string;
  readonly limitations: string;
  readonly citations: ReadonlyArray<{ readonly physicalPage: number; readonly quote: string }>;
}

export interface ParsedQuiz5 {
  readonly items: ReadonlyArray<{
    readonly question: string;
    readonly answer: string;
    readonly physicalPage: number;
    readonly quote: string;
  }>;
}

export interface ParsedFigureExplain {
  readonly title: string;
  readonly steps: ReadonlyArray<string>;
  readonly takeaway: string;
}

export interface DeepReadPreferencesState {
  readonly depthMode: ReadingDepthMode;
  readonly layoutMode: RailLayoutMode;
  readonly highlightDensity: HighlightDensity;
  readonly cardFontSize: number;
  readonly railWidth: number;
  readonly keepExpanded: boolean;
  readonly railCollapsed: boolean;
  readonly focusMode: boolean;
  readonly readingGoal: string;
  readonly furthestPage: number;
}

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function unwrapPrefValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const parsed = safeJsonParse(trimmed);
    if (typeof parsed === "string") return parsed;
  }
  return raw;
}

export function parsePreferences(
  rawPrefs: Readonly<Record<string, string>>,
): DeepReadPreferencesState {
  const depthRaw = unwrapPrefValue(rawPrefs.depthMode);
  const depthMode: ReadingDepthMode =
    depthRaw === "highlights" || depthRaw === "margins" ? depthRaw : "full";
  const layoutRaw = unwrapPrefValue(rawPrefs.layoutMode);
  const layoutMode: RailLayoutMode = layoutRaw === "right" ? "right" : "split";
  const densityRaw = unwrapPrefValue(rawPrefs.highlightDensity);
  const highlightDensity: HighlightDensity =
    densityRaw === "off" || densityRaw === "low" || densityRaw === "high" ? densityRaw : "medium";
  const parsedFont = Number(unwrapPrefValue(rawPrefs.cardFontSize));
  const cardFontSize = Number.isFinite(parsedFont)
    ? Math.max(12, Math.min(18, Math.round(parsedFont)))
    : 13;
  const parsedWidth = Number(unwrapPrefValue(rawPrefs.railWidth));
  const railWidth = Number.isFinite(parsedWidth)
    ? Math.max(200, Math.min(420, Math.round(parsedWidth)))
    : 280;
  const parsedFurthest = Number(unwrapPrefValue(rawPrefs.furthestPage));
  const furthestPage =
    Number.isFinite(parsedFurthest) && parsedFurthest >= 1 ? Math.floor(parsedFurthest) : 1;

  return {
    depthMode,
    layoutMode,
    highlightDensity,
    cardFontSize,
    railWidth,
    keepExpanded: unwrapPrefValue(rawPrefs.keepExpanded) === "true",
    railCollapsed: unwrapPrefValue(rawPrefs.railCollapsed) === "true",
    focusMode: unwrapPrefValue(rawPrefs.focusMode) === "true",
    readingGoal: unwrapPrefValue(rawPrefs.readingGoal) ?? "",
    furthestPage,
  };
}

export function parseParagraphAnalysis(
  analysisJson: string | null | undefined,
): ParsedParagraphAnalysis | null {
  const obj = safeJsonParse(analysisJson);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Record<string, unknown>;
  const roleCandidate = typeof raw.role === "string" ? raw.role : "background";
  const role: ParagraphRole =
    roleCandidate in PARAGRAPH_ROLE_STYLES ? (roleCandidate as ParagraphRole) : "background";
  const imp =
    typeof raw.importance === "number" ? Math.max(1, Math.min(5, Math.round(raw.importance))) : 3;
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const points = Array.isArray(raw.points)
    ? raw.points.filter((item): item is string => typeof item === "string")
    : [];
  const explanation = typeof raw.explanation === "string" ? raw.explanation : "";
  const translation = typeof raw.translation === "string" ? raw.translation : "";
  const keySentence = typeof raw.keySentence === "string" ? raw.keySentence : undefined;
  return {
    role,
    importance: imp,
    summary,
    points,
    explanation,
    translation,
    ...(keySentence ? { keySentence } : {}),
  };
}

export function parseGuideInsight(
  insights: ReadonlyArray<LibraryReadingInsightContract>,
): DeepReadGuide | null {
  const found = insights.find((item) => item.kind === "guide");
  if (!found) return null;
  const obj = safeJsonParse(found.payloadJson);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Partial<DeepReadGuide>;
  if (!raw.position && !raw.skeleton && !raw.method && !raw.evidence && !raw.takeaway) return null;
  return {
    position: raw.position ?? {},
    skeleton: raw.skeleton ?? {},
    method: raw.method ?? {},
    evidence: raw.evidence ?? {},
    takeaway: raw.takeaway ?? {},
    ...(raw.type ? { type: raw.type } : {}),
    ...(raw.markdown ? { markdown: raw.markdown } : {}),
    ...(raw.meta ? { meta: raw.meta } : {}),
  };
}

export function parseSummary5Insight(
  insights: ReadonlyArray<LibraryReadingInsightContract>,
): ParsedSummary5 | null {
  const found = insights.find((item) => item.kind === "summary5");
  if (!found) return null;
  const obj = safeJsonParse(found.payloadJson);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Partial<ParsedSummary5>;
  return {
    problem: typeof raw.problem === "string" ? raw.problem : "",
    method: typeof raw.method === "string" ? raw.method : "",
    findings: typeof raw.findings === "string" ? raw.findings : "",
    evidence: typeof raw.evidence === "string" ? raw.evidence : "",
    limitations: typeof raw.limitations === "string" ? raw.limitations : "",
    citations: Array.isArray(raw.citations) ? raw.citations : [],
  };
}

export function parseQuiz5Insight(
  insights: ReadonlyArray<LibraryReadingInsightContract>,
): ParsedQuiz5 | null {
  const found = insights.find((item) => item.kind === "quiz5");
  if (!found) return null;
  const obj = safeJsonParse(found.payloadJson);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Partial<ParsedQuiz5>;
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
  };
}

export function parseFigureExplainJson(rawJson: string): ParsedFigureExplain | null {
  const obj = safeJsonParse(rawJson);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Record<string, unknown>;
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    steps: Array.isArray(raw.steps)
      ? raw.steps.filter((item): item is string => typeof item === "string")
      : [],
    takeaway: typeof raw.takeaway === "string" ? raw.takeaway : "",
  };
}

export function parseQuestionSources(sourcesJson: string): ReadonlyArray<{
  readonly physicalPage: number;
  readonly quote: string;
}> {
  const parsed = safeJsonParse(sourcesJson);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is { physicalPage: number; quote: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { physicalPage?: unknown }).physicalPage === "number",
  );
}

const CAPTION_RE = /^(Fig(?:ure)?\.?|Table|Tab\.)\s*(\d+|[IVX]+)\b/i;
const HEADING_RE =
  /^(?:#{1,4}\s+|(?:\d+(?:\.\d+)*\.?\s+)[A-Z]|(?:Abstract|Introduction|Related Work|Method|Methodology|Experiments|Results|Discussion|Conclusion|Limitations|References)\b)/u;

/**
 * Fallback deterministic paragraph segmentation from extracted text pages (used for non-PDF
 * entries or before PDF.js finishes extracting coordinates for a page).
 */
export function buildFallbackPageParagraphs(
  physicalPage: number,
  text: string,
): ReadonlyArray<PaperParagraphBlock> {
  const chunks = text
    .split(/\n{2,}/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  if (chunks.length === 0) return [];
  const step = 92 / Math.max(chunks.length, 1);
  return chunks.map((chunk, idx) => {
    const paragraphIndex = idx;
    const captionMatch = CAPTION_RE.exec(chunk);
    const figureKind: "figure" | "table" | null = captionMatch
      ? captionMatch[1]!.toLowerCase().startsWith("tab")
        ? "table"
        : "figure"
      : null;
    const figureLabel = captionMatch
      ? `${figureKind === "table" ? "Table" : "Fig."} ${captionMatch[2]}`
      : null;
    const isHeading = !captionMatch && chunk.length <= 120 && HEADING_RE.test(chunk);
    const columnSide: "left" | "right" | "full" =
      chunks.length >= 2 && !isHeading ? (idx % 2 === 0 ? "left" : "right") : "full";
    const leftPct = columnSide === "right" ? 52 : 6;
    const widthPct = columnSide === "full" ? 88 : 42;
    return {
      key: formatBlockKey(physicalPage, paragraphIndex),
      label: formatBlockLabel(physicalPage, paragraphIndex),
      physicalPage,
      paragraphIndex,
      anchor: computeParagraphAnchor(physicalPage, chunk),
      text: chunk,
      rect: {
        left: leftPct,
        top: Math.min(92, Math.round(4 + idx * step)),
        width: widthPct,
        height: Math.max(6, Math.round(step * 0.85)),
      },
      columnSide,
      isHeading,
      isCaption: captionMatch !== null,
      figureLabel,
      figureKind,
    };
  });
}

export function buildDocumentPages(
  entry: LibraryEntry,
  pages: ReadonlyArray<LibraryEntryPageContract>,
): ReadonlyArray<{ readonly physicalPage: number; readonly text: string }> {
  if (pages.length > 0) {
    return pages.map((page) => ({
      physicalPage: page.physicalPage,
      text: page.text,
    }));
  }
  const pageSections = entry.body.split(/^\[p\.(\d+)\]\s*$/gmu);
  if (pageSections.length >= 3) {
    const result: Array<{ readonly physicalPage: number; readonly text: string }> = [];
    for (let i = 1; i + 1 < pageSections.length; i += 2) {
      const pageNum = Number(pageSections[i]);
      const bodyText = (pageSections[i + 1] ?? "").trim();
      if (Number.isFinite(pageNum) && pageNum >= 1 && bodyText.length > 0) {
        result.push({ physicalPage: pageNum, text: bodyText });
      }
    }
    if (result.length > 0) return result;
  }
  return [{ physicalPage: 1, text: entry.body }];
}

export function extractDocumentStructure(
  docPages: ReadonlyArray<{ readonly physicalPage: number; readonly text: string }>,
  allParagraphs: ReadonlyArray<PaperParagraphBlock>,
): {
  readonly sections: ReadonlyArray<ReadingSection>;
  readonly figures: ReadonlyArray<PaperFigureItem>;
  readonly references: ReadonlyArray<ReferenceEntry>;
  readonly estimatedMinutes: number;
} {
  const sections = extractSections(allParagraphs);
  const figures = extractFigures(allParagraphs);
  const references = extractReferences(docPages);
  const totalChars = docPages.reduce((sum, page) => sum + page.text.length, 0);
  const estimatedMinutes = Math.max(1, Math.round(totalChars / 1400));
  return { sections, figures, references, estimatedMinutes };
}

export function parseAnchorRefTarget(
  ref: string | null | undefined,
): { readonly physicalPage: number; readonly blockKey: string | null } | null {
  if (!ref) return null;
  const parsedKey = parseBlockKey(ref);
  if (parsedKey) {
    return {
      physicalPage: parsedKey.physicalPage,
      blockKey: formatBlockKey(parsedKey.physicalPage, parsedKey.paragraphIndex),
    };
  }
  const pageMatch = /p\.?\s*(\d+)/iu.exec(ref);
  if (!pageMatch?.[1]) return null;
  const num = Number(pageMatch[1]);
  if (!Number.isFinite(num) || num < 1) return null;
  return { physicalPage: Math.floor(num), blockKey: null };
}

export function shouldIgnoreReaderShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function shouldHighlightParagraph(
  density: HighlightDensity,
  persisted: LibraryReadingParagraphContract | undefined,
  analysis: ParsedParagraphAnalysis | null,
): boolean {
  if (persisted?.highlighted) return true;
  if (density === "off") return false;
  if (!analysis) return false;
  if (density === "low") return analysis.importance >= 5;
  if (density === "medium") return analysis.importance >= 4;
  return analysis.importance >= 3;
}

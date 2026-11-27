import type {
  DeepReadGuide,
  HoverLookupResult,
  LibraryLookupCandidate,
  PaperFigureItem,
  PaperParagraphBlock,
  ReadingDepthMode,
  ReadingSection,
  ReferenceEntry,
} from "./types.ts";

const FIGURE_REF_RE =
  /(?<![A-Za-z])(Fig(?:ure)?s?\.?|Tables?|Tab\.)\s*(\d+|[IVX]+)(?:\s*\(?([a-z])\)?(?![A-Za-z]))?/gi;
const NUMERIC_CITE_RE = /\[(\d+(?:\s*[-–,]\s*\d+)*)\]/g;
const AUTHOR_YEAR_CITE_RE = /\(([A-Z][A-Za-z-]+(?:\s+et\s+al\.)?),?\s*(\d{4}[a-z]?)\)/g;
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/i;

function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/[.,;)\]]+$/u, "")
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeTitleForMatch(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^a-z0-9\u4e00-\u9fff]+/gu, " ")
    .trim();
}

function countWords(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  const latinWords = text
    .replaceAll(/[\u4e00-\u9fff]/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 0).length;
  return cjkCount + latinWords;
}

/**
 * Extracts document sections for DeepRead's Structure Bar without LLM calls.
 */
export function extractSections(
  paragraphs: ReadonlyArray<PaperParagraphBlock>,
): ReadonlyArray<ReadingSection> {
  if (paragraphs.length === 0) return [];
  const sections: Array<{
    title: string;
    startPage: number;
    endPage: number;
    firstParagraphKey: string;
    wordCount: number;
  }> = [];

  for (const para of paragraphs) {
    if (para.isHeading) {
      sections.push({
        title: para.text.replace(/^#{1,4}\s+/u, "").trim(),
        startPage: para.physicalPage,
        endPage: para.physicalPage,
        firstParagraphKey: para.key,
        wordCount: countWords(para.text),
      });
      continue;
    }
    const current = sections.at(-1);
    if (!current) {
      sections.push({
        title: "Overview",
        startPage: para.physicalPage,
        endPage: para.physicalPage,
        firstParagraphKey: para.key,
        wordCount: countWords(para.text),
      });
    } else {
      current.endPage = Math.max(current.endPage, para.physicalPage);
      current.wordCount += countWords(para.text);
    }
  }

  return sections.map((section, idx) => ({
    id: `sec_${idx}`,
    title: section.title,
    startPage: section.startPage,
    endPage: section.endPage,
    firstParagraphKey: section.firstParagraphKey,
    wordCount: section.wordCount,
    estimatedMinutes: Math.max(1, Math.round(section.wordCount / 220)),
  }));
}

/**
 * Extracts indexed figures and tables from paragraph captions for the Figure selector and hover lookup.
 */
export function extractFigures(
  paragraphs: ReadonlyArray<PaperParagraphBlock>,
): ReadonlyArray<PaperFigureItem> {
  const items: PaperFigureItem[] = [];
  const seen = new Set<string>();
  for (const para of paragraphs) {
    if (!para.isCaption || !para.figureLabel || !para.figureKind) continue;
    const numMatch = /(\d+|[IVX]+)$/i.exec(para.figureLabel);
    const num = numMatch ? numMatch[1]! : String(items.length + 1);
    const id = `${para.figureKind}:${num.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      kind: para.figureKind,
      number: num,
      label: para.figureLabel,
      caption: para.text,
      physicalPage: para.physicalPage,
      paragraphKey: para.key,
      rect: para.rect,
    });
  }
  return items;
}

/**
 * Extracts bibliography reference entries from pages containing a References section.
 */
export function extractReferences(
  pages: ReadonlyArray<{ readonly physicalPage: number; readonly text: string }>,
): ReadonlyArray<ReferenceEntry> {
  const entries: ReferenceEntry[] = [];
  let inReferences = false;

  for (const page of pages) {
    const lines = page.text.replaceAll("\r\n", "\n").split("\n");
    let currentIndex: number | null = null;
    let buffer: string[] = [];

    const flush = () => {
      const raw = buffer.join(" ").replaceAll(/\s+/gu, " ").trim();
      if (!raw || raw.length < 12) {
        buffer = [];
        currentIndex = null;
        return;
      }
      const doiMatch = DOI_RE.exec(raw);
      const yearMatch = /\b(19\d{2}|20\d{2}[a-z]?)\b/.exec(raw);
      const quotedTitle = /[“"]([^”"]{8,220})[”"]/.exec(raw)?.[1] ?? null;
      const parts = raw.split(/\.\s+/u);
      const fallbackTitle = parts.length >= 2 && parts[1]!.length >= 8 ? parts[1]!.trim() : null;
      const authors = (parts[0] ?? raw).replace(/^\[\d+\]\s*/u, "").slice(0, 120);
      const key = currentIndex !== null ? `[${currentIndex}]` : `ref_${entries.length + 1}`;
      entries.push({
        index: currentIndex,
        key,
        rawText: raw,
        authors,
        year: yearMatch?.[1] ?? null,
        title: quotedTitle ?? fallbackTitle,
        doi: normalizeDoi(doiMatch?.[1]),
        physicalPage: page.physicalPage,
      });
      buffer = [];
      currentIndex = null;
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!inReferences) {
        if (/^(?:\d+\.?\s+)?references\b/i.test(trimmed)) {
          inReferences = true;
        }
        continue;
      }
      const numbered = /^\[(\d+)\]\s*(.+)$/.exec(trimmed);
      if (numbered) {
        flush();
        currentIndex = Number.parseInt(numbered[1]!, 10);
        buffer.push(numbered[2]!);
        continue;
      }
      if (trimmed.length === 0) {
        flush();
      } else {
        buffer.push(trimmed);
      }
    }
    flush();
  }

  return entries;
}

/**
 * Strict library match per DeepRead `docs/LOOKUP_INTERACTION.md`:
 * - Matching normalized DOI wins immediately.
 * - A candidate with a DIFFERENT DOI never matches by title alone.
 * - Title fallback requires either a unique candidate OR all matching candidates sharing the same DOI.
 */
export function matchReferenceInLibrary(
  reference: Pick<ReferenceEntry, "doi" | "title">,
  candidates: ReadonlyArray<LibraryLookupCandidate>,
): LibraryLookupCandidate | null {
  const refDoi = normalizeDoi(reference.doi);
  if (refDoi) {
    const byDoi = candidates.find((candidate) => normalizeDoi(candidate.doi) === refDoi);
    if (byDoi) return byDoi;
  }

  const refTitle = normalizeTitleForMatch(reference.title);
  if (refTitle.length < 8) return null;

  const titleMatches = candidates.filter((candidate) => {
    const candTitle = normalizeTitleForMatch(candidate.title);
    if (!candTitle || candTitle !== refTitle) return false;
    const candDoi = normalizeDoi(candidate.doi);
    if (refDoi && candDoi && candDoi !== refDoi) return false;
    return true;
  });

  if (titleMatches.length === 0) return null;
  if (titleMatches.length === 1) return titleMatches[0]!;

  const distinctDois = new Set(titleMatches.map((item) => normalizeDoi(item.doi)));
  if (distinctDois.size === 1 && !distinctDois.has(null)) {
    return titleMatches[0]!;
  }
  return null;
}

/**
 * Resolves hover lookup tokens (citations, figures, tables) without model calls.
 */
export function resolveHoverLookup(input: {
  readonly text: string;
  readonly cursorOffset?: number | undefined;
  readonly figures: ReadonlyArray<PaperFigureItem>;
  readonly references: ReadonlyArray<ReferenceEntry>;
  readonly libraryCandidates?: ReadonlyArray<LibraryLookupCandidate> | undefined;
}): HoverLookupResult | null {
  const offset = input.cursorOffset ?? 0;
  const candidates = input.libraryCandidates ?? [];

  // 1. Check figure / table references first
  FIGURE_REF_RE.lastIndex = 0;
  let figMatch: RegExpExecArray | null;
  while ((figMatch = FIGURE_REF_RE.exec(input.text)) !== null) {
    const start = figMatch.index;
    const end = start + figMatch[0].length;
    if (input.cursorOffset !== undefined && (offset < start - 1 || offset > end + 1)) {
      continue;
    }
    const kind: "figure" | "table" = figMatch[1]!.toLowerCase().startsWith("tab")
      ? "table"
      : "figure";
    const num = figMatch[2]!.toLowerCase();
    const matched = input.figures.find(
      (fig) => fig.kind === kind && fig.number.toLowerCase() === num,
    );
    if (matched) {
      return {
        kind,
        token: figMatch[0],
        title: matched.label,
        body: matched.caption,
        physicalPage: matched.physicalPage,
        paragraphKey: matched.paragraphKey,
        figure: matched,
        libraryMatch: null,
      };
    }
  }

  // 2. Check numeric citations like [12] or [1, 3]
  NUMERIC_CITE_RE.lastIndex = 0;
  let numMatch: RegExpExecArray | null;
  while ((numMatch = NUMERIC_CITE_RE.exec(input.text)) !== null) {
    const start = numMatch.index;
    const end = start + numMatch[0].length;
    if (input.cursorOffset !== undefined && (offset < start - 1 || offset > end + 1)) {
      continue;
    }
    const firstNum = Number.parseInt(numMatch[1]!.split(/[-–,]/u)[0]!.trim(), 10);
    const ref = input.references.find((entry) => entry.index === firstNum);
    if (ref) {
      return {
        kind: "citation",
        token: numMatch[0],
        title: ref.title ?? ref.key,
        body: ref.rawText,
        physicalPage: ref.physicalPage,
        paragraphKey: null,
        reference: ref,
        libraryMatch: matchReferenceInLibrary(ref, candidates),
      };
    }
  }

  // 3. Check author-year citations like (Ho et al., 2020)
  AUTHOR_YEAR_CITE_RE.lastIndex = 0;
  let ayMatch: RegExpExecArray | null;
  while ((ayMatch = AUTHOR_YEAR_CITE_RE.exec(input.text)) !== null) {
    const start = ayMatch.index;
    const end = start + ayMatch[0].length;
    if (input.cursorOffset !== undefined && (offset < start - 1 || offset > end + 1)) {
      continue;
    }
    const surname = ayMatch[1]!.split(/\s+/u)[0]!.toLowerCase();
    const year = ayMatch[2]!;
    const ref = input.references.find(
      (entry) => entry.year === year && entry.authors.toLowerCase().includes(surname),
    );
    if (ref) {
      return {
        kind: "citation",
        token: ayMatch[0],
        title: ref.title ?? ref.key,
        body: ref.rawText,
        physicalPage: ref.physicalPage,
        paragraphKey: null,
        reference: ref,
        libraryMatch: matchReferenceInLibrary(ref, candidates),
      };
    }
  }

  return null;
}

/**
 * Finds the next or previous key paragraph for DeepRead's N / Shift+N and "Next key ↓" navigation.
 */
export function findNextKeyParagraph(input: {
  readonly paragraphs: ReadonlyArray<PaperParagraphBlock>;
  readonly currentKey: string | null;
  readonly direction: "next" | "prev";
  readonly depthMode: ReadingDepthMode;
  readonly keyPredicate: (paragraph: PaperParagraphBlock) => boolean;
}): PaperParagraphBlock | null {
  const eligible =
    input.depthMode === "full"
      ? input.paragraphs.filter((p) => !p.isHeading && input.keyPredicate(p))
      : input.paragraphs.filter((p) => input.keyPredicate(p));
  const targetPool = eligible.length > 0 ? eligible : input.paragraphs.filter((p) => !p.isHeading);
  if (targetPool.length === 0) return null;

  if (!input.currentKey) {
    return input.direction === "next" ? targetPool[0]! : targetPool.at(-1)!;
  }

  const currentIdx = input.paragraphs.findIndex((p) => p.key === input.currentKey);
  if (currentIdx < 0) {
    return input.direction === "next" ? targetPool[0]! : targetPool.at(-1)!;
  }

  const poolWithOrder = targetPool.map((p) => ({
    paragraph: p,
    order: input.paragraphs.findIndex((item) => item.key === p.key),
  }));

  if (input.direction === "next") {
    const after = poolWithOrder.find((item) => item.order > currentIdx);
    return (after ?? poolWithOrder[0])!.paragraph;
  }
  const before = [...poolWithOrder].reverse().find((item) => item.order < currentIdx);
  return (before ?? poolWithOrder.at(-1))!.paragraph;
}

/**
 * Parses either a DeepRead Guide JSON document (`GUIDE_SCHEMA.md`) or imported Markdown
 * into a normalized 5-stage DeepReadGuide object.
 */
export function parseDeepReadGuideImport(raw: string): DeepReadGuide {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Guide import content is empty.");
  }
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Partial<DeepReadGuide>;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid DeepRead guide JSON object.");
    }
    return {
      ...(parsed.type ? { type: parsed.type } : {}),
      position: parsed.position ?? {},
      skeleton: parsed.skeleton ?? {},
      method: parsed.method ?? {},
      evidence: parsed.evidence ?? {},
      takeaway: parsed.takeaway ?? {},
      ...(parsed.markdown ? { markdown: parsed.markdown } : {}),
      meta: {
        ...parsed.meta,
        kind: parsed.meta?.kind ?? "import",
      },
    };
  }

  // Markdown import: extract cited `[p. X ¶Y]` block keys and summarize into 5 stages cleanly.
  const lines = trimmed.split("\n");
  const firstHeading = lines
    .find((line) => /^#+\s+/.test(line))
    ?.replace(/^#+\s+/, "")
    .trim();
  const bulletLines = lines
    .filter((line) => /^[-*]\s+/.test(line.trim()))
    .map((line) => line.trim().replace(/^[-*]\s+/, ""));
  const citedKeys: string[] = [];
  const citePattern = /\[p\.\s*(\d+)\s*¶(\d+)\]/gu;
  let match: RegExpExecArray | null;
  while ((match = citePattern.exec(trimmed)) !== null) {
    const page = Number.parseInt(match[1]!, 10);
    const para = Number.parseInt(match[2]!, 10);
    if (page >= 1 && para >= 1) {
      citedKeys.push(`p_${page - 1}_${para - 1}`);
    }
  }

  return {
    type: "research",
    position: {
      claim: firstHeading ?? trimmed.slice(0, 280),
      questions: bulletLines.slice(0, 3),
    },
    skeleton: {
      moves: bulletLines.slice(0, 6).map((text, idx) => ({
        role: idx === 0 ? "contribution" : "evidence",
        text,
        keys: citedKeys.slice(idx, idx + 1),
        status: "pending" as const,
      })),
    },
    method: {},
    evidence: {},
    takeaway: {
      summary: firstHeading ?? trimmed.slice(0, 180),
      learned: bulletLines.slice(0, 5),
    },
    markdown: {
      xray: trimmed,
    },
    meta: {
      kind: "import",
      source: "markdown",
    },
  };
}

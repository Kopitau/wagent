import {
  READING_ANCHOR_ALGO_VERSION,
  type ContinuationCandidate,
  type PageRectPct,
  type PaperParagraphBlock,
  type RailCardInput,
  type RailCardPlacement,
  type TextSpanBox,
} from "./types.ts";

const HEADING_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:abstract|introduction|related work|background|method|methodology|approach|experiments?|results?|evaluation|discussion|limitations?|conclusion|conclusions|references|acknowledgements?|appendix)\b/i,
  /^(?:\d+(?:\.\d+)*|[IVX]+)\.?\s+[A-Z\u4e00-\u9fff][^\n]{1,100}$/,
  /^#{1,4}\s+.+/,
];

const CAPTION_RE = /^(Fig(?:ure)?\.?|Table|Tab\.)\s*(\d+|[IVX]+)(?:\s*[:.\-\u2014])?\s*(.*)$/i;

export function normalizeAnchorQuote(text: string): string {
  return text.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Pure browser-safe 128-bit FNV-1a anchor hash (two independent 64-bit lanes).
 * Deterministic across browser and Node with zero crypto/DOM dependencies.
 */
export function computeParagraphAnchor(physicalPage: number, text: string): string {
  const normalized = normalizeAnchorQuote(text).slice(0, 600);
  const input = `v${READING_ANCHOR_ALGO_VERSION}:p${physicalPage}:${normalized}`;
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x84222325cbf29ce4n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    const code = BigInt(input.charCodeAt(i));
    h1 = ((h1 ^ code) * prime) & mask;
    h2 = ((h2 ^ (code + BigInt(i + 1))) * prime) & mask;
  }
  return `a${READING_ANCHOR_ALGO_VERSION}_${h1.toString(16).padStart(16, "0")}${h2.toString(16).padStart(16, "0").slice(0, 8)}`;
}

export function formatBlockKey(physicalPage: number, paragraphIndex: number): string {
  const page0 = Math.max(0, physicalPage - 1);
  return `p_${page0}_${paragraphIndex}`;
}

export function formatBlockLabel(physicalPage: number, paragraphIndex: number): string {
  return `p. ${physicalPage} ¶${paragraphIndex + 1}`;
}

export function parseBlockKey(
  key: string,
): { readonly physicalPage: number; readonly paragraphIndex: number } | null {
  const match = /^p_(\d+)_(\d+)$/.exec(key.trim());
  if (!match) return null;
  const page0 = Number.parseInt(match[1]!, 10);
  const paragraphIndex = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(page0) || !Number.isSafeInteger(paragraphIndex)) return null;
  return { physicalPage: page0 + 1, paragraphIndex };
}

function classifyHeading(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 140) return false;
  if (trimmed.includes("\n")) return false;
  if (CAPTION_RE.test(trimmed)) return false;
  return HEADING_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function classifyCaption(text: string): {
  readonly isCaption: boolean;
  readonly figureLabel: string | null;
  readonly figureKind: "figure" | "table" | null;
} {
  const trimmed = text.trim();
  const match = CAPTION_RE.exec(trimmed);
  if (!match) {
    return { isCaption: false, figureLabel: null, figureKind: null };
  }
  const prefix = match[1]!.toLowerCase();
  const num = match[2]!;
  const kind: "figure" | "table" = prefix.startsWith("tab") ? "table" : "figure";
  return {
    isCaption: true,
    figureLabel: `${kind === "table" ? "Table" : "Fig."} ${num}`,
    figureKind: kind,
  };
}

export function detectTwoColumnPage(rects: ReadonlyArray<PageRectPct>): boolean {
  const narrow = rects.filter((rect) => rect.width > 8 && rect.width <= 52);
  if (narrow.length < 4) return false;
  const leftCount = narrow.filter((rect) => rect.left + rect.width / 2 < 48).length;
  const rightCount = narrow.filter((rect) => rect.left + rect.width / 2 > 52).length;
  return leftCount >= 2 && rightCount >= 2;
}

export function classifyColumnSide(
  rect: PageRectPct,
  isTwoColumn: boolean,
): "left" | "right" | "full" {
  if (rect.width > 60) return "full";
  if (!isTwoColumn) return "full";
  return rect.left + rect.width / 2 < 50 ? "left" : "right";
}

function mergeLineBoxesIntoParagraphs(spans: ReadonlyArray<TextSpanBox>): Array<{
  readonly text: string;
  readonly rect: PageRectPct;
  readonly columnSide: "left" | "right" | "full";
}> {
  const nonEmpty = spans.filter((span) => span.text.trim().length > 0);
  if (nonEmpty.length === 0) return [];

  const isTwoCol = detectTwoColumnPage(nonEmpty);

  const buckets = isTwoCol
    ? {
        full: nonEmpty.filter((span) => span.width > 58),
        left: nonEmpty.filter((span) => span.width <= 58 && span.left + span.width / 2 < 50),
        right: nonEmpty.filter((span) => span.width <= 58 && span.left + span.width / 2 >= 50),
      }
    : {
        full: nonEmpty,
        left: [] as TextSpanBox[],
        right: [] as TextSpanBox[],
      };

  const groupLines = (
    items: ReadonlyArray<TextSpanBox>,
    side: "left" | "right" | "full",
  ): Array<{
    readonly text: string;
    readonly rect: PageRectPct;
    readonly columnSide: "left" | "right" | "full";
  }> => {
    if (items.length === 0) return [];
    const sorted = items.toSorted((a, b) =>
      Math.abs(a.top - b.top) <= 0.8 ? a.left - b.left : a.top - b.top,
    );

    const lines: Array<{
      text: string;
      left: number;
      top: number;
      right: number;
      bottom: number;
      height: number;
    }> = [];
    for (const span of sorted) {
      const prev = lines.at(-1);
      const spanBottom = span.top + span.height;
      const spanRight = span.left + span.width;
      if (prev && Math.abs(span.top - prev.top) <= Math.max(0.9, prev.height * 0.55)) {
        const needsSpace = !prev.text.endsWith("-") && !span.text.startsWith(" ");
        prev.text = prev.text.endsWith("-")
          ? prev.text.slice(0, -1) + span.text.trimStart()
          : `${prev.text}${needsSpace ? " " : ""}${span.text.trim()}`;
        prev.left = Math.min(prev.left, span.left);
        prev.top = Math.min(prev.top, span.top);
        prev.right = Math.max(prev.right, spanRight);
        prev.bottom = Math.max(prev.bottom, spanBottom);
        prev.height = Math.max(prev.height, span.height);
      } else {
        lines.push({
          text: span.text.trim(),
          left: span.left,
          top: span.top,
          right: spanRight,
          bottom: spanBottom,
          height: Math.max(span.height, 1),
        });
      }
    }

    const paragraphs: Array<{
      text: string;
      left: number;
      top: number;
      right: number;
      bottom: number;
    }> = [];
    for (const line of lines) {
      const prev = paragraphs.at(-1);
      const verticalGap = prev ? line.top - prev.bottom : Number.POSITIVE_INFINITY;
      const lineGapThreshold = Math.max(1.3, line.height * 0.85);
      const startsHeadingOrCaption =
        classifyHeading(line.text) || classifyCaption(line.text).isCaption;
      const prevIsHeading = prev ? classifyHeading(prev.text) : false;
      const indentedNewPara = prev
        ? line.left - prev.left > 1.8 && /[.!?。！？]$/.test(prev.text)
        : false;

      if (
        prev &&
        !startsHeadingOrCaption &&
        !prevIsHeading &&
        !indentedNewPara &&
        verticalGap <= lineGapThreshold
      ) {
        const joiner =
          /[\u4e00-\u9fff]$/.test(prev.text) && /^[\u4e00-\u9fff]/.test(line.text) ? "" : " ";
        prev.text = prev.text.endsWith("-")
          ? prev.text.slice(0, -1) + line.text
          : `${prev.text}${joiner}${line.text}`;
        prev.left = Math.min(prev.left, line.left);
        prev.top = Math.min(prev.top, line.top);
        prev.right = Math.max(prev.right, line.right);
        prev.bottom = Math.max(prev.bottom, line.bottom);
      } else {
        paragraphs.push({
          text: line.text,
          left: line.left,
          top: line.top,
          right: line.right,
          bottom: line.bottom,
        });
      }
    }

    return paragraphs.map((p) => ({
      text: p.text.trim(),
      rect: {
        left: Math.max(0, Math.min(100, p.left)),
        top: Math.max(0, Math.min(100, p.top)),
        width: Math.max(1, Math.min(100 - p.left, p.right - p.left)),
        height: Math.max(1, Math.min(100 - p.top, p.bottom - p.top)),
      },
      columnSide: side,
    }));
  };

  const fullTop = groupLines(
    buckets.full.filter((s) => s.top < 35),
    "full",
  );
  const leftBlocks = groupLines(buckets.left, "left");
  const rightBlocks = groupLines(buckets.right, "right");
  const fullBottom = groupLines(
    buckets.full.filter((s) => s.top >= 35),
    "full",
  );

  return [...fullTop, ...leftBlocks, ...rightBlocks, ...fullBottom].filter(
    (block) => block.text.length > 0,
  );
}

/**
 * Segments a physical page (1-based) into DeepRead paragraphs.
 * Uses real PDF.js text-span geometry when available, or cleanly splits extracted page text.
 */
export function segmentPageToParagraphs(input: {
  readonly physicalPage: number;
  readonly pageText: string;
  readonly spans?: ReadonlyArray<TextSpanBox> | undefined;
}): ReadonlyArray<PaperParagraphBlock> {
  if (input.spans && input.spans.length > 0) {
    const blocks = mergeLineBoxesIntoParagraphs(input.spans);
    return blocks.map((block, paragraphIndex) => {
      const caption = classifyCaption(block.text);
      return {
        key: formatBlockKey(input.physicalPage, paragraphIndex),
        label: formatBlockLabel(input.physicalPage, paragraphIndex),
        physicalPage: input.physicalPage,
        paragraphIndex,
        anchor: computeParagraphAnchor(input.physicalPage, block.text),
        text: block.text,
        rect: block.rect,
        columnSide: block.columnSide,
        isHeading: classifyHeading(block.text),
        isCaption: caption.isCaption,
        figureLabel: caption.figureLabel,
        figureKind: caption.figureKind,
      };
    });
  }

  const rawChunks = input.pageText
    .replaceAll("\r\n", "\n")
    .split(/\n{2,}/u)
    .map((chunk) => chunk.replaceAll(/\s+/gu, " ").trim())
    .filter((chunk) => chunk.length > 0);

  if (rawChunks.length === 0) return [];
  const totalChars = rawChunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
  let cursorTop = 6;
  const usableHeight = 86;

  return rawChunks.map((text, paragraphIndex) => {
    const share = Math.max(4, (text.length / totalChars) * usableHeight);
    const height = Math.min(usableHeight - (cursorTop - 6), share);
    const rect: PageRectPct = {
      left: 8,
      top: Math.min(92, cursorTop),
      width: 84,
      height: Math.max(3, height),
    };
    cursorTop = Math.min(92, cursorTop + height + 1.2);
    const caption = classifyCaption(text);
    return {
      key: formatBlockKey(input.physicalPage, paragraphIndex),
      label: formatBlockLabel(input.physicalPage, paragraphIndex),
      physicalPage: input.physicalPage,
      paragraphIndex,
      anchor: computeParagraphAnchor(input.physicalPage, text),
      text,
      rect,
      columnSide: "full",
      isHeading: classifyHeading(text),
      isCaption: caption.isCaption,
      figureLabel: caption.figureLabel,
      figureKind: caption.figureKind,
    };
  });
}

const SENTENCE_END_RE = /[.!?。！？]["'”’)\]]*$/;

/**
 * Proposes cross-column or cross-page paragraph continuation pairs.
 * Never crosses headings, captions, or section boundaries.
 */
export function detectContinuationCandidates(
  paragraphs: ReadonlyArray<PaperParagraphBlock>,
): ReadonlyArray<ContinuationCandidate> {
  const candidates: ContinuationCandidate[] = [];
  for (let i = 0; i < paragraphs.length - 1; i += 1) {
    const current = paragraphs[i]!;
    const next = paragraphs[i + 1]!;
    if (current.isHeading || current.isCaption || next.isHeading || next.isCaption) continue;
    if (current.text.length < 30 || next.text.length < 20) continue;

    const endsSentence = SENTENCE_END_RE.test(current.text.trim());
    const startsLower = /^[a-z,;)\]]/.test(next.text.trim());
    if (endsSentence && !startsLower) continue;

    if (
      current.physicalPage === next.physicalPage &&
      current.columnSide === "left" &&
      next.columnSide === "right"
    ) {
      candidates.push({
        leadKey: current.key,
        tailKey: next.key,
        reason: "cross_column",
      });
    } else if (next.physicalPage === current.physicalPage + 1) {
      candidates.push({
        leadKey: current.key,
        tailKey: next.key,
        reason: "cross_page",
      });
    } else if (startsLower) {
      candidates.push({
        leadKey: current.key,
        tailKey: next.key,
        reason: "unfinished_sentence",
      });
    }
  }
  return candidates;
}

/**
 * DeepRead non-overlapping margin card layout algorithm.
 * Anchors each card to its paragraph's vertical coordinate and pushes overlapping
 * cards downward with a fixed gap, independently for left and right rails.
 */
export function layoutRailCards(
  cards: ReadonlyArray<RailCardInput>,
  options?: { readonly gap?: number | undefined; readonly minTop?: number | undefined },
): ReadonlyArray<RailCardPlacement> {
  const gap = options?.gap ?? 10;
  const minTop = options?.minTop ?? 8;

  const layoutSide = (sideCards: ReadonlyArray<RailCardInput>): RailCardPlacement[] => {
    const sorted = sideCards.toSorted((left, right) => left.anchorY - right.anchorY);
    const placed: RailCardPlacement[] = [];
    let nextAvailableTop = minTop;

    for (const card of sorted) {
      const top = Math.max(minTop, card.anchorY, nextAvailableTop);
      const height = Math.max(28, card.height);
      placed.push({
        key: card.key,
        side: card.side,
        anchorY: card.anchorY,
        top,
        height,
        connectorFromY: card.anchorY + 12,
        connectorToY: top + Math.min(20, height / 2),
      });
      nextAvailableTop = top + height + gap;
    }
    return placed;
  };

  return [
    ...layoutSide(cards.filter((c) => c.side === "left")),
    ...layoutSide(cards.filter((c) => c.side === "right")),
  ];
}

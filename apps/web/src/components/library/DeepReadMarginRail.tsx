import type { LibraryReadingParagraphContract } from "@t3tools/contracts";
import {
  layoutRailCards,
  PARAGRAPH_ROLE_STYLES,
  WKB_ANNOTATION_KINDS,
  type ContinuationCandidate,
  type PaperParagraphBlock,
  type RailCardPlacement,
  type WkbAnnotationKind,
} from "@t3tools/research-library/reader";
import { T, useGT, Var } from "gt-react";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  HelpCircleIcon,
  HighlighterIcon,
  Link2Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  StickyNoteIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

import { parseFigureExplainJson, parseParagraphAnalysis } from "./deepreadHelpers";

export interface DeepReadMarginRailProps {
  readonly side: "left" | "right";
  readonly stageHeightPx: number;
  readonly railWidthPx: number;
  readonly paragraphs: ReadonlyArray<PaperParagraphBlock>;
  readonly persistedByAnchor: ReadonlyMap<string, LibraryReadingParagraphContract>;
  readonly continuations: ReadonlyArray<ContinuationCandidate>;
  readonly activeKey: string | null;
  readonly expandedKeys: ReadonlySet<string>;
  readonly keepExpanded: boolean;
  readonly hiddenKeys: ReadonlySet<string>;
  readonly canWrite: boolean;
  readonly busyAnchor: string | null;
  readonly onSelectParagraph: (block: PaperParagraphBlock) => void;
  readonly onToggleExpand: (key: string) => void;
  readonly onHideCard: (key: string) => void;
  readonly onAnalyzeParagraph: (block: PaperParagraphBlock) => void;
  readonly onAskParagraph: (block: PaperParagraphBlock) => void;
  readonly onSaveParagraphPatch: (input: {
    readonly block: PaperParagraphBlock;
    readonly note?: string | undefined;
    readonly marked?: boolean | undefined;
    readonly highlighted?: boolean | undefined;
    readonly wkbKind?: WkbAnnotationKind | undefined;
  }) => void;
  readonly onExplainFigure: (block: PaperParagraphBlock) => void;
  readonly onMergeContinuation: (lead: PaperParagraphBlock, tail: PaperParagraphBlock) => void;
}

const COMPACT_CARD_HEIGHT = 86;
const EXPANDED_CARD_HEIGHT = 270;

export function DeepReadMarginRail({
  side,
  stageHeightPx,
  railWidthPx,
  paragraphs,
  persistedByAnchor,
  continuations,
  activeKey,
  expandedKeys,
  keepExpanded,
  hiddenKeys,
  canWrite,
  busyAnchor,
  onSelectParagraph,
  onToggleExpand,
  onHideCard,
  onAnalyzeParagraph,
  onAskParagraph,
  onSaveParagraphPatch,
  onExplainFigure,
  onMergeContinuation,
}: DeepReadMarginRailProps) {
  const gt = useGT();
  const [editingNoteKey, setEditingNoteKey] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [translationOpenKeys, setTranslationOpenKeys] = useState<ReadonlySet<string>>(new Set());

  const visibleBlocks = paragraphs.filter((block) => !hiddenKeys.has(block.key));
  const placements: ReadonlyArray<RailCardPlacement> = layoutRailCards(
    visibleBlocks.map((block) => {
      const isExpanded =
        keepExpanded || expandedKeys.has(block.key) || editingNoteKey === block.key;
      return {
        key: block.key,
        side,
        anchorY: (block.rect.top / 100) * stageHeightPx,
        height: isExpanded ? EXPANDED_CARD_HEIGHT : COMPACT_CARD_HEIGHT,
      };
    }),
    { gap: 10, minTop: 6 },
  );

  const placementByKey = new Map(placements.map((item) => [item.key, item]));
  const totalHeight = Math.max(
    stageHeightPx,
    placements.reduce((max, item) => Math.max(max, item.top + item.height + 24), 0),
  );

  const toggleTranslation = (key: string) => {
    setTranslationOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (visibleBlocks.length === 0) {
    return (
      <aside
        aria-label={side === "left" ? gt("Left margin rail") : gt("Right margin rail")}
        className="shrink-0"
        data-deepread="rail"
        data-side={side}
        data-testid={`deepread-rail-${side}`}
        style={{ width: railWidthPx, minHeight: stageHeightPx }}
      />
    );
  }

  return (
    <aside
      aria-label={side === "left" ? gt("Left margin rail") : gt("Right margin rail")}
      className="shrink-0"
      data-deepread="rail"
      data-side={side}
      data-testid={`deepread-rail-${side}`}
      style={{ width: railWidthPx, minHeight: totalHeight }}
    >
      {/* Subtle SVG Bezier connectors tying cards back to paragraph anchors */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute top-0 overflow-visible"
        height={totalHeight}
        style={side === "left" ? { right: -14 } : { left: -14 }}
        width={14}
      >
        {placements.map((item) => {
          const isActive = item.key === activeKey;
          const x1 = side === "left" ? 0 : 14;
          const x2 = side === "left" ? 14 : 0;
          const cx = 7;
          const path = `M ${x1} ${item.connectorToY} C ${cx} ${item.connectorToY}, ${cx} ${item.connectorFromY}, ${x2} ${item.connectorFromY}`;
          return (
            <path
              key={item.key}
              d={path}
              fill="none"
              stroke={isActive ? "var(--dr-accent)" : "var(--dr-border)"}
              strokeOpacity={isActive ? 0.9 : 0.7}
              strokeWidth={isActive ? 2 : 1}
            />
          );
        })}
      </svg>

      {visibleBlocks.map((block) => {
        const placement = placementByKey.get(block.key);
        if (!placement) return null;
        const persisted = persistedByAnchor.get(block.anchor);
        const analysis = parseParagraphAnalysis(persisted?.analysisJson);
        const roleStyle = analysis
          ? PARAGRAPH_ROLE_STYLES[analysis.role]
          : PARAGRAPH_ROLE_STYLES.background;
        const isExpanded =
          keepExpanded || expandedKeys.has(block.key) || editingNoteKey === block.key;
        const isActive = activeKey === block.key;
        const isMarked = persisted?.marked ?? false;
        const isHighlighted = persisted?.highlighted ?? false;
        const wkbKind = (persisted?.wkbKind as WkbAnnotationKind | undefined) ?? "重点";
        const isBusy = busyAnchor === block.anchor;
        const continuation = continuations.find((c) => c.tailKey === block.key);
        const leadBlock = continuation
          ? (paragraphs.find((p) => p.key === continuation.leadKey) ?? null)
          : null;

        const isFigureCard = block.isCaption && block.figureKind !== null;
        const figureExplain =
          isFigureCard && persisted?.analysisJson
            ? parseFigureExplainJson(persisted.analysisJson)
            : null;
        const borderAccent = isFigureCard
          ? block.figureKind === "table"
            ? "var(--dr-table)"
            : "var(--dr-figure)"
          : roleStyle.accent;

        return (
          <article
            key={block.key}
            className="absolute inset-x-0 p-2.5"
            data-active={isActive ? "true" : "false"}
            data-anchor={block.anchor}
            data-card-kind={isFigureCard ? block.figureKind : "paragraph"}
            data-deepread="card"
            data-expanded={isExpanded ? "true" : "false"}
            data-role={analysis?.role ?? (isFigureCard ? block.figureKind : "unassigned")}
            data-testid={`deepread-card-${block.key}`}
            style={{
              top: placement.top,
              borderLeftColor: borderAccent,
            }}
          >
            {/* Compact header: explicit click expands/collapses (NEVER pops open on hover!) */}
            <div className="flex items-start justify-between gap-1.5">
              <button
                aria-expanded={isExpanded}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                data-testid={`deepread-card-toggle-${block.key}`}
                type="button"
                onClick={() => {
                  onSelectParagraph(block);
                  onToggleExpand(block.key);
                }}
              >
                {isExpanded ? (
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className="shrink-0"
                  data-deepread="role-badge"
                  style={{ backgroundColor: borderAccent }}
                >
                  {isFigureCard ? block.figureLabel : roleStyle.labelZh}
                </span>
                <span className="truncate font-medium text-2xs text-muted-foreground">
                  {block.label}
                </span>
              </button>

              <div className="flex shrink-0 items-center gap-1">
                {persisted?.note ? (
                  <Badge size="sm" variant="secondary">
                    {wkbKind}
                  </Badge>
                ) : null}
                <span data-deepread="muddiest-wrap" data-pressed={isMarked ? "true" : "false"}>
                  <Button
                    aria-label={gt("Mark as muddiest point")}
                    aria-pressed={isMarked}
                    disabled={!canWrite}
                    size="xs"
                    title={gt("Mark as muddiest point")}
                    variant="ghost"
                    onClick={() =>
                      onSaveParagraphPatch({
                        block,
                        marked: !isMarked,
                        wkbKind: !isMarked ? "存疑" : wkbKind,
                      })
                    }
                  >
                    <HelpCircleIcon className="size-3" />
                  </Button>
                </span>
              </div>
            </div>

            {/* 1-line compact summary */}
            <p className="mt-1 line-clamp-2 text-xs">
              {analysis?.summary || block.text.slice(0, 120)}
            </p>

            {/* Expanded details (strictly click-controlled) */}
            {isExpanded ? (
              <div className="mt-2 flex flex-col gap-2 border-t pt-2">
                {figureExplain && figureExplain.steps.length > 0 ? (
                  <div className="flex flex-col gap-1">
                    {figureExplain.title ? (
                      <p className="font-medium text-xs">{figureExplain.title}</p>
                    ) : null}
                    <ol className="list-decimal space-y-1 pl-4 text-xs">
                      {figureExplain.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    {figureExplain.takeaway ? (
                      <p className="text-muted-foreground text-xs">{figureExplain.takeaway}</p>
                    ) : null}
                  </div>
                ) : null}

                {analysis && analysis.points.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-4 text-xs">
                    {analysis.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                ) : null}

                {analysis?.explanation ? (
                  <p className="text-muted-foreground text-xs">{analysis.explanation}</p>
                ) : null}

                {analysis?.translation ? (
                  <div>
                    <Button size="xs" variant="ghost" onClick={() => toggleTranslation(block.key)}>
                      {translationOpenKeys.has(block.key) ? (
                        <T>Hide translation</T>
                      ) : (
                        <T>Show serif translation</T>
                      )}
                    </Button>
                    {translationOpenKeys.has(block.key) ? (
                      <p
                        className="mt-1 rounded-md border bg-muted/20 p-2 text-xs"
                        data-deepread="translation-serif"
                      >
                        {analysis.translation}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* Personal note box (green border per DeepRead design) */}
                {persisted?.note && editingNoteKey !== block.key ? (
                  <div className="text-xs" data-deepread="note-box">
                    <div className="mb-0.5 flex items-center justify-between text-2xs font-medium">
                      <span>
                        <T>
                          Personal note · <Var>{wkbKind}</Var>
                        </T>
                      </span>
                      {canWrite ? (
                        <button
                          className="underline"
                          type="button"
                          onClick={() => {
                            setEditingNoteKey(block.key);
                            setNoteDraft(persisted.note);
                          }}
                        >
                          <T>Edit</T>
                        </button>
                      ) : null}
                    </div>
                    <p className="whitespace-pre-wrap">{persisted.note}</p>
                  </div>
                ) : null}

                {/* Inline note editor + 6-kind wkb annotation picker */}
                {editingNoteKey === block.key ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-1">
                      {WKB_ANNOTATION_KINDS.map((kind) => (
                        <Button
                          key={kind}
                          size="xs"
                          variant={wkbKind === kind ? "secondary" : "outline"}
                          onClick={() => onSaveParagraphPatch({ block, wkbKind: kind })}
                        >
                          {kind}
                        </Button>
                      ))}
                    </div>
                    <Textarea
                      aria-label={gt("Paragraph note")}
                      placeholder={gt("Write your note or takeaway for this paragraph...")}
                      rows={3}
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                    />
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="xs"
                        onClick={() => {
                          onSaveParagraphPatch({ block, note: noteDraft });
                          setEditingNoteKey(null);
                        }}
                      >
                        <T>Save note</T>
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setEditingNoteKey(null)}>
                        <T>Cancel</T>
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* Common action strip: Note / Ask / Verify source / More */}
                <div className="flex flex-wrap items-center gap-1 border-t pt-1.5">
                  <Button
                    disabled={!canWrite}
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setEditingNoteKey(block.key);
                      setNoteDraft(persisted?.note ?? "");
                    }}
                  >
                    <StickyNoteIcon className="size-3" />
                    <T>Note</T>
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onAskParagraph(block)}>
                    <MessageSquareIcon className="size-3" />
                    <T>Ask</T>
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onSelectParagraph(block)}>
                    <ExternalLinkIcon className="size-3" />
                    <T>
                      Check (p.<Var>{block.physicalPage}</Var>)
                    </T>
                  </Button>
                  <Button
                    aria-label={gt("More card actions")}
                    size="xs"
                    variant="ghost"
                    onClick={() => setOpenMenuKey(openMenuKey === block.key ? null : block.key)}
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </Button>
                </div>

                {openMenuKey === block.key ? (
                  <div className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/30 p-1.5">
                    <Button
                      disabled={!canWrite || isBusy}
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setOpenMenuKey(null);
                        if (isFigureCard) onExplainFigure(block);
                        else onAnalyzeParagraph(block);
                      }}
                    >
                      <BotIcon className="size-3" />
                      {isBusy ? (
                        <T>Analyzing...</T>
                      ) : isFigureCard ? (
                        <T>AI read figure</T>
                      ) : (
                        <T>AI analyze</T>
                      )}
                    </Button>
                    <Button
                      disabled={!canWrite}
                      size="xs"
                      variant={isHighlighted ? "secondary" : "outline"}
                      onClick={() => onSaveParagraphPatch({ block, highlighted: !isHighlighted })}
                    >
                      <HighlighterIcon className="size-3" />
                      {isHighlighted ? <T>Unhighlight</T> : <T>Highlight</T>}
                    </Button>
                    {leadBlock ? (
                      <Button
                        disabled={!canWrite}
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setOpenMenuKey(null);
                          onMergeContinuation(leadBlock, block);
                        }}
                      >
                        <Link2Icon className="size-3" />
                        <T>Merge prev</T>
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setOpenMenuKey(null);
                        onHideCard(block.key);
                      }}
                    >
                      <T>Hide card</T>
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </aside>
  );
}

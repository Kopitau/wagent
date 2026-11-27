import type { LibraryEntry, LibraryReadingParagraphContract } from "@t3tools/contracts";
import {
  resolveHoverLookup,
  segmentPageToParagraphs,
  type HighlightDensity,
  type HoverLookupResult,
  type LibraryLookupCandidate,
  type PaperFigureItem,
  type PaperParagraphBlock,
  type ReadingDepthMode,
  type ReferenceEntry,
  type TextSpanBox,
} from "@t3tools/research-library/reader";
import { msg, T, useGT, Var } from "gt-react";
import { AlertTriangleIcon, BookOpenIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { openPdf } from "~/components/files/pdfDocument";
import "~/components/files/pdfViewer.css";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { m } from "~/i18n/messages";

import { parseParagraphAnalysis, shouldHighlightParagraph } from "./deepreadHelpers";

export interface DeepReadPdfStageProps {
  readonly entry: LibraryEntry;
  readonly hasPdf: boolean;
  readonly loadPdfBytes: (
    signal: AbortSignal,
    options: { readonly reload: boolean },
  ) => Promise<ArrayBuffer>;
  readonly currentPage: number;
  readonly zoomPct: number;
  readonly depthMode: ReadingDepthMode;
  readonly highlightDensity: HighlightDensity;
  readonly paragraphs: ReadonlyArray<PaperParagraphBlock>;
  readonly persistedByAnchor: ReadonlyMap<string, LibraryReadingParagraphContract>;
  readonly figures: ReadonlyArray<PaperFigureItem>;
  readonly references: ReadonlyArray<ReferenceEntry>;
  readonly libraryCandidates: ReadonlyArray<LibraryLookupCandidate>;
  readonly activeKey: string | null;
  readonly onTotalPagesResolved: (totalPages: number) => void;
  readonly onPageHeightResolved: (heightPx: number) => void;
  readonly onPageParagraphsResolved: (
    physicalPage: number,
    blocks: ReadonlyArray<PaperParagraphBlock>,
  ) => void;
  readonly onSelectParagraph: (block: PaperParagraphBlock) => void;
  readonly onJumpToPage: (page: number, blockKey?: string) => void;
  readonly onOpenLibraryEntry: (entryId: string) => void;
}

interface PopoverCoords {
  readonly x: number;
  readonly y: number;
}

function clampPopoverPosition(clientX: number, clientY: number): PopoverCoords {
  const maxX = Math.max(16, (typeof window !== "undefined" ? window.innerWidth : 1200) - 400);
  const maxY = Math.max(16, (typeof window !== "undefined" ? window.innerHeight : 800) - 240);
  return {
    x: Math.max(16, Math.min(maxX, clientX + 12)),
    y: Math.max(16, Math.min(maxY, clientY + 14)),
  };
}

export function DeepReadPdfStage({
  entry,
  hasPdf,
  loadPdfBytes,
  currentPage,
  zoomPct,
  depthMode,
  highlightDensity,
  paragraphs,
  persistedByAnchor,
  figures,
  references,
  libraryCandidates,
  activeKey,
  onTotalPagesResolved,
  onPageHeightResolved,
  onPageParagraphsResolved,
  onSelectParagraph,
  onJumpToPage,
  onOpenLibraryEntry,
}: DeepReadPdfStageProps) {
  const gt = useGT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [pdfLoadState, setPdfLoadState] = useState<{
    readonly docKey: string;
    readonly doc: PDFDocumentProxy | null;
    readonly error: string | null;
  } | null>(null);
  const [sheetSize, setSheetSize] = useState<{ readonly width: number; readonly height: number }>({
    width: 680,
    height: 920,
  });

  // Hover lookup (zero LLM calls) takes visual priority and hides hover translation while active.
  const [hoverLookup, setHoverLookup] = useState<{
    readonly result: HoverLookupResult;
    readonly pos: PopoverCoords;
  } | null>(null);
  const [hoverTranslation, setHoverTranslation] = useState<{
    readonly block: PaperParagraphBlock;
    readonly text: string;
    readonly pos: PopoverCoords;
  } | null>(null);
  const [popoverPinned, setPopoverPinned] = useState(false);

  const pageWidthPx = Math.round((680 * zoomPct) / 100);
  const docKey = `${entry.id}:${entry.blobSha256 ?? ""}`;
  const pdfDoc =
    hasPdf && !entry.blobMissing && pdfLoadState?.docKey === docKey ? pdfLoadState.doc : null;
  const pdfError =
    hasPdf && !entry.blobMissing && pdfLoadState?.docKey === docKey ? pdfLoadState.error : null;
  const pdfLoading =
    hasPdf && !entry.blobMissing && (pdfLoadState === null || pdfLoadState.docKey !== docKey);

  const fetchBytesEvent = useEffectEvent(loadPdfBytes);
  const totalPagesEvent = useEffectEvent(onTotalPagesResolved);
  const pageHeightEvent = useEffectEvent(onPageHeightResolved);
  const pageParagraphsEvent = useEffectEvent(onPageParagraphsResolved);

  // Load PDF document via singleton PDFWorker when entry has an intact PDF blob.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes pdf.js PDFDocumentProxy lifecycle with entry identity and cancels in-flight fetches on unmount.
  useEffect(() => {
    if (!hasPdf || entry.blobMissing) return;
    const controller = new AbortController();
    let destroyed = false;
    let loadingTask: ReturnType<typeof openPdf> | null = null;

    void (async () => {
      try {
        const bytes = await fetchBytesEvent(controller.signal, { reload: false });
        if (destroyed || controller.signal.aborted) return;
        loadingTask = openPdf(bytes);
        const doc = await loadingTask.promise;
        if (destroyed || controller.signal.aborted) {
          void loadingTask.destroy();
          return;
        }
        setPdfLoadState({ docKey, doc, error: null });
        totalPagesEvent(doc.numPages);
      } catch (error) {
        if (destroyed || controller.signal.aborted) return;
        setPdfLoadState({
          docKey,
          doc: null,
          error: error instanceof Error ? error.message : m(msg("Failed to load PDF document.")),
        });
      }
    })();

    return () => {
      destroyed = true;
      controller.abort();
      if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [docKey, entry.blobMissing, hasPdf]);

  // Render active physical PDF page onto offscreen-buffered canvas + extract real two-column geometry.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Renders PDF.js page canvas and text layer, extracting paragraph coordinates and cleaning up pdf.js page resources.
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    let loadedPage: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | null = null;
    let renderTask: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null =
      null;
    let textLayer: TextLayer | null = null;

    void (async () => {
      try {
        const clampedPage = Math.max(1, Math.min(pdfDoc.numPages, currentPage));
        const page = await pdfDoc.getPage(clampedPage);
        loadedPage = page;
        if (cancelled) {
          page.cleanup();
          return;
        }

        const natural = page.getViewport({ scale: 1 });
        const scale = pageWidthPx / natural.width;
        const viewport = page.getViewport({ scale });
        const nextWidth = Math.round(viewport.width);
        const nextHeight = Math.round(viewport.height);
        setSheetSize({ width: nextWidth, height: nextHeight });
        pageHeightEvent(nextHeight);

        // Extract text span coordinates for authentic two-column segmentation
        const textContent = await page.getTextContent();
        if (cancelled) return;
        const spanBoxes: TextSpanBox[] = [];
        for (const item of textContent.items) {
          if (!("str" in item) || !item.str.trim()) continue;
          const tx = item.transform;
          const x = tx[4] ?? 0;
          const yFromBottom = tx[5] ?? 0;
          const fontHeight = Math.max(6, Math.hypot(tx[2] ?? 0, tx[3] ?? 0) || item.height || 10);
          const itemWidth = Math.max(2, item.width || item.str.length * (fontHeight * 0.45));
          const leftPct = Math.max(0, Math.min(100, (x / natural.width) * 100));
          const topPct = Math.max(
            0,
            Math.min(100, ((natural.height - yFromBottom - fontHeight) / natural.height) * 100),
          );
          const widthPct = Math.max(
            0.5,
            Math.min(100 - leftPct, (itemWidth / natural.width) * 100),
          );
          const heightPct = Math.max(
            0.5,
            Math.min(100 - topPct, (fontHeight / natural.height) * 100),
          );
          spanBoxes.push({
            text: item.str,
            left: leftPct,
            top: topPct,
            width: widthPct,
            height: heightPct,
            fontSize: fontHeight,
          });
        }
        if (spanBoxes.length > 0) {
          const segmented = segmentPageToParagraphs({
            physicalPage: clampedPage,
            pageText: spanBoxes.map((span) => span.text).join(" "),
            spans: spanBoxes,
          });
          if (segmented.length > 0) {
            pageParagraphsEvent(clampedPage, segmented);
          }
        }

        // Paint PDF page via offscreen buffer to prevent white flicker during zoom
        const canvas = canvasRef.current;
        if (canvas) {
          const ratio = Math.min(
            2,
            window.devicePixelRatio || 1,
            Math.sqrt((8 * 1024 * 1024) / Math.max(1, viewport.width * viewport.height)),
          );
          const buffer = document.createElement("canvas");
          buffer.width = Math.ceil(viewport.width * ratio);
          buffer.height = Math.ceil(viewport.height * ratio);
          renderTask = page.render({
            canvas: buffer,
            viewport,
            transform: [ratio, 0, 0, ratio, 0, 0],
            background: "white",
          });
          await renderTask.promise;
          if (!cancelled && canvasRef.current) {
            canvasRef.current.width = buffer.width;
            canvasRef.current.height = buffer.height;
            canvasRef.current.getContext("2d", { alpha: false })?.drawImage(buffer, 0, 0);
            buffer.width = 0;
          }
        }

        if (textLayerRef.current && !cancelled) {
          textLayerRef.current.replaceChildren();
          textLayerRef.current.style.setProperty("--total-scale-factor", String(viewport.scale));
          textLayer = new TextLayer({
            container: textLayerRef.current,
            viewport,
            textContentSource: textContent,
          });
          await textLayer.render();
        }
      } catch {
        // Ignore cancellation errors on rapid page turns.
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      loadedPage?.cleanup();
    };
  }, [pdfDoc, currentPage, pageWidthPx]);

  // Esc key cleanly dismisses any active hover lookup or translation popover.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Attaches window Esc listener to dismiss active hover popovers.
  useEffect(() => {
    if (!hoverLookup && !hoverTranslation) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHoverLookup(null);
        setHoverTranslation(null);
        setPopoverPinned(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hoverLookup, hoverTranslation]);

  const handleParagraphPointerEnter = (
    block: PaperParagraphBlock,
    clientX: number,
    clientY: number,
  ) => {
    // Probe hover lookup first (citations [18], (Author, 2020), Fig. 3, Table 1) with zero LLM calls.
    const lookup = resolveHoverLookup({
      text: block.text,
      figures,
      references,
      libraryCandidates,
    });
    const pos = clampPopoverPosition(clientX, clientY);
    if (lookup) {
      setHoverTranslation(null);
      setHoverLookup({ result: lookup, pos });
      return;
    }
    const persisted = persistedByAnchor.get(block.anchor);
    const analysis = parseParagraphAnalysis(persisted?.analysisJson);
    if (analysis?.translation) {
      setHoverLookup(null);
      setHoverTranslation({
        block,
        text: analysis.translation,
        pos,
      });
    }
  };

  const handleParagraphPointerLeave = () => {
    if (popoverPinned) return;
    setHoverLookup(null);
    setHoverTranslation(null);
  };

  if (depthMode === "margins") {
    return (
      <div
        className="flex min-w-0 flex-1 flex-col items-center justify-center rounded-lg border border-dashed bg-background/60 p-6 text-center text-muted-foreground text-xs"
        data-testid="deepread-margins-only-placeholder"
      >
        <BookOpenIcon className="mb-2 size-5 opacity-60" />
        <p>
          <T>Margins-only mode active. Switch back to Full or Highlights to view original pages.</T>
        </p>
      </div>
    );
  }

  return (
    <div
      ref={stageRef}
      className="relative flex min-w-0 flex-1 flex-col items-center gap-3"
      data-testid="deepread-pdf-stage"
    >
      {entry.blobMissing ? (
        <Alert className="w-full max-w-2xl" variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>
            <T>Original PDF file missing</T>
          </AlertTitle>
          <AlertDescription>
            <T>
              Showing extracted text paragraphs with full DeepRead margin cards and AI reading
              tools.
            </T>
          </AlertDescription>
        </Alert>
      ) : null}

      {pdfError ? (
        <Alert className="w-full max-w-2xl" variant="error">
          <AlertTriangleIcon />
          <AlertDescription>{pdfError}</AlertDescription>
        </Alert>
      ) : null}

      {hasPdf && !entry.blobMissing && !pdfError ? (
        <div
          className="overflow-hidden"
          data-deepread="pdf-sheet"
          style={{ width: sheetSize.width, height: sheetSize.height }}
        >
          {pdfLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner className="size-5" />
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            className="block size-full"
            style={{ width: sheetSize.width, height: sheetSize.height }}
          />
          <div
            ref={textLayerRef}
            className="pointer-events-none absolute inset-0"
            data-pdf-text-layer=""
          />

          {/* Interactive paragraph overlays synced with left/right margin rail cards */}
          <div className="absolute inset-0">
            {paragraphs.map((block) => {
              const persisted = persistedByAnchor.get(block.anchor);
              const analysis = parseParagraphAnalysis(persisted?.analysisJson);
              const isHighlighted = shouldHighlightParagraph(highlightDensity, persisted, analysis);
              const isActive = activeKey === block.key;
              const dimmed =
                depthMode === "highlights" && !isHighlighted && !persisted?.marked && !isActive;

              return (
                <button
                  key={block.key}
                  aria-label={`${block.label} ${block.text.slice(0, 60)}`}
                  className="absolute rounded-xs text-left transition-colors hover:bg-accent/20"
                  data-active={isActive ? "true" : "false"}
                  data-anchor={block.anchor}
                  data-deepread="para-block"
                  data-highlighted={isHighlighted ? "true" : "false"}
                  data-testid={`deepread-overlay-${block.key}`}
                  style={{
                    left: `${block.rect.left}%`,
                    top: `${block.rect.top}%`,
                    width: `${block.rect.width}%`,
                    height: `${block.rect.height}%`,
                    opacity: dimmed ? 0.25 : 1,
                  }}
                  type="button"
                  onClick={() => onSelectParagraph(block)}
                  onMouseEnter={(event) =>
                    handleParagraphPointerEnter(block, event.clientX, event.clientY)
                  }
                  onMouseLeave={handleParagraphPointerLeave}
                />
              );
            })}
          </div>
        </div>
      ) : (
        /* Structured text-page reading sheet for non-PDF entries or missing-blob fallback */
        <div
          className="w-full max-w-2xl p-6"
          data-deepread="pdf-sheet"
          data-testid="deepread-text-sheet"
          style={{ minHeight: 720 }}
        >
          <div className="mb-4 flex items-center justify-between border-b pb-2 text-muted-foreground text-xs">
            <span className="font-medium">{entry.title}</span>
            <span className="tabular-nums">
              <T>
                Page <Var>{currentPage}</Var>
              </T>
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {paragraphs.map((block) => {
              const persisted = persistedByAnchor.get(block.anchor);
              const analysis = parseParagraphAnalysis(persisted?.analysisJson);
              const isHighlighted = shouldHighlightParagraph(highlightDensity, persisted, analysis);
              const isActive = activeKey === block.key;
              const dimmed =
                depthMode === "highlights" && !isHighlighted && !persisted?.marked && !isActive;

              return (
                <div
                  key={block.key}
                  className="cursor-pointer rounded-md p-2.5 text-sm leading-relaxed transition-opacity hover:bg-accent/40"
                  data-active={isActive ? "true" : "false"}
                  data-anchor={block.anchor}
                  data-deepread="para-block"
                  data-highlighted={isHighlighted ? "true" : "false"}
                  data-testid={`deepread-text-block-${block.key}`}
                  role="button"
                  style={{ opacity: dimmed ? 0.32 : 1 }}
                  tabIndex={0}
                  onClick={() => onSelectParagraph(block)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectParagraph(block);
                    }
                  }}
                  onMouseEnter={(event) =>
                    handleParagraphPointerEnter(block, event.clientX, event.clientY)
                  }
                  onMouseLeave={handleParagraphPointerLeave}
                >
                  <div className="mb-1 flex items-center gap-2 text-2xs text-muted-foreground">
                    <span>{block.label}</span>
                    {block.isHeading ? (
                      <Badge size="sm" variant="outline">
                        <T>Heading</T>
                      </Badge>
                    ) : null}
                    {block.figureLabel ? (
                      <Badge size="sm" variant="secondary">
                        {block.figureLabel}
                      </Badge>
                    ) : null}
                  </div>
                  <p className={block.isHeading ? "font-semibold text-base" : ""}>{block.text}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Hover Lookup Popover (zero LLM calls, takes priority over translation popover) */}
      {hoverLookup ? (
        <div
          className="fixed p-3 text-xs"
          data-deepread="popover"
          data-testid="deepread-hover-lookup-popover"
          role="dialog"
          style={{ left: hoverLookup.pos.x, top: hoverLookup.pos.y }}
          onMouseEnter={() => setPopoverPinned(true)}
          onMouseLeave={() => {
            setPopoverPinned(false);
            setHoverLookup(null);
          }}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Badge size="sm" variant="secondary">
                {hoverLookup.result.token}
              </Badge>
              <span className="font-semibold">{hoverLookup.result.title}</span>
            </div>
            <Button
              aria-label={gt("Close lookup popover")}
              size="xs"
              variant="ghost"
              onClick={() => {
                setHoverLookup(null);
                setPopoverPinned(false);
              }}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
          <p className="line-clamp-4 text-muted-foreground">{hoverLookup.result.body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {hoverLookup.result.physicalPage !== null ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  const targetPage = hoverLookup.result.physicalPage!;
                  const targetKey = hoverLookup.result.paragraphKey ?? undefined;
                  setHoverLookup(null);
                  setPopoverPinned(false);
                  onJumpToPage(targetPage, targetKey);
                }}
              >
                <T>
                  Jump to p.<Var>{hoverLookup.result.physicalPage}</Var>
                </T>
              </Button>
            ) : null}
            {hoverLookup.result.libraryMatch ? (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => onOpenLibraryEntry(hoverLookup.result.libraryMatch!.id)}
              >
                <ExternalLinkIcon className="size-3" />
                <T>Open in Library</T>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Hover Translation Popover (viewport-clamped, retains focus on hover, hidden during lookup) */}
      {!hoverLookup && hoverTranslation ? (
        <div
          className="fixed p-3 text-xs"
          data-deepread="popover"
          data-testid="deepread-hover-translation-popover"
          role="tooltip"
          style={{ left: hoverTranslation.pos.x, top: hoverTranslation.pos.y }}
          onMouseEnter={() => setPopoverPinned(true)}
          onMouseLeave={() => {
            setPopoverPinned(false);
            setHoverTranslation(null);
          }}
        >
          <div className="mb-1 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
            <span>
              <T>
                Translation · <Var>{hoverTranslation.block.label}</Var>
              </T>
            </span>
            <Button
              aria-label={gt("Close translation popover")}
              size="xs"
              variant="ghost"
              onClick={() => {
                setHoverTranslation(null);
                setPopoverPinned(false);
              }}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
          <p className="text-xs" data-deepread="translation-serif">
            {hoverTranslation.text}
          </p>
        </div>
      ) : null}
    </div>
  );
}

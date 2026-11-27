import type {
  PaperFigureItem,
  RailLayoutMode,
  ReadingDepthMode,
  ReadingSection,
} from "@t3tools/research-library/reader";
import { T, useGT, Var } from "gt-react";
import {
  ArrowDownIcon,
  Columns2Icon,
  EyeOffIcon,
  FocusIcon,
  HelpCircleIcon,
  ImageIcon,
  MinusIcon,
  PanelRightIcon,
  PlusIcon,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

export interface DeepReadStructureBarProps {
  readonly sections: ReadonlyArray<ReadingSection>;
  readonly figures: ReadonlyArray<PaperFigureItem>;
  readonly currentPage: number;
  readonly totalPages: number;
  readonly furthestPage: number;
  readonly estimatedMinutes: number;
  readonly depthMode: ReadingDepthMode;
  readonly layoutMode: RailLayoutMode;
  readonly railCollapsed: boolean;
  readonly focusMode: boolean;
  readonly panelOpen: boolean;
  readonly muddiestCount: number;
  readonly zoomPct: number;
  readonly onJumpToPage: (page: number, blockKey?: string) => void;
  readonly onChangeDepthMode: (mode: ReadingDepthMode) => void;
  readonly onNextKeyParagraph: () => void;
  readonly onChangeLayoutMode: (mode: RailLayoutMode) => void;
  readonly onToggleRailCollapsed: () => void;
  readonly onToggleFocusMode: () => void;
  readonly onTogglePanel: () => void;
  readonly onOpenMuddiestList: () => void;
  readonly onStepZoom: (delta: number) => void;
}

export function DeepReadStructureBar({
  sections,
  figures,
  currentPage,
  totalPages,
  furthestPage,
  estimatedMinutes,
  depthMode,
  layoutMode,
  railCollapsed,
  focusMode,
  panelOpen,
  muddiestCount,
  zoomPct,
  onJumpToPage,
  onChangeDepthMode,
  onNextKeyParagraph,
  onChangeLayoutMode,
  onToggleRailCollapsed,
  onToggleFocusMode,
  onTogglePanel,
  onOpenMuddiestList,
  onStepZoom,
}: DeepReadStructureBarProps) {
  const gt = useGT();

  const activeSection =
    sections.find((sec) => currentPage >= sec.startPage && currentPage <= sec.endPage) ??
    sections[0] ??
    null;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
      data-deepread="structure-bar"
      data-testid="deepread-structure-bar"
    >
      {/* Group 1: Document structure & physical page position */}
      <div className="flex flex-wrap items-center gap-2">
        {sections.length > 0 ? (
          <Select
            value={activeSection?.id ?? sections[0]!.id}
            onValueChange={(nextId) => {
              const target = sections.find((sec) => sec.id === nextId);
              if (target) onJumpToPage(target.startPage, target.firstParagraphKey);
            }}
          >
            <SelectTrigger aria-label={gt("Document sections")} className="max-w-xs" size="sm">
              <SelectValue>
                {activeSection
                  ? `${activeSection.title} (p.${activeSection.startPage})`
                  : gt("Sections")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {sections.map((section) => (
                <SelectItem key={section.id} value={section.id}>
                  <span className="flex w-full items-center justify-between gap-3">
                    <span>{section.title}</span>
                    <span className="text-muted-foreground tabular-nums">
                      p.{section.startPage}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}

        <div className="flex items-center gap-1 rounded-md border px-2 py-1 tabular-nums">
          <Button
            aria-label={gt("Previous page")}
            disabled={currentPage <= 1}
            size="xs"
            variant="ghost"
            onClick={() => onJumpToPage(Math.max(1, currentPage - 1))}
          >
            -
          </Button>
          <span data-testid="deepread-page-indicator">
            <T>
              p.<Var>{currentPage}</Var> / <Var>{Math.max(1, totalPages)}</Var>
            </T>
          </span>
          <Button
            aria-label={gt("Next page")}
            disabled={currentPage >= Math.max(1, totalPages)}
            size="xs"
            variant="ghost"
            onClick={() => onJumpToPage(Math.min(Math.max(1, totalPages), currentPage + 1))}
          >
            +
          </Button>
        </div>

        <Badge size="sm" variant="outline">
          <T>
            Furthest p.<Var>{furthestPage}</Var>
          </T>
        </Badge>

        <span className="text-muted-foreground tabular-nums">
          <T>
            ~<Var>{estimatedMinutes}</Var> min
          </T>
        </span>
      </div>

      {/* Group 2: Skim depth, next key, figures, muddiest, layout, zoom, panel */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div
          aria-label={gt("Reading depth")}
          className="inline-flex items-center rounded-md border p-0.5"
          role="group"
        >
          {(["full", "highlights", "margins"] as const).map((mode) => (
            <Button
              key={mode}
              size="xs"
              variant={depthMode === mode ? "secondary" : "ghost"}
              onClick={() => onChangeDepthMode(mode)}
            >
              {mode === "full" ? (
                <T>Full</T>
              ) : mode === "highlights" ? (
                <T>Highlights</T>
              ) : (
                <T>Margins only</T>
              )}
            </Button>
          ))}
        </div>

        <Button
          size="xs"
          title={gt("Jump to next key paragraph (N / Shift+N)")}
          variant="outline"
          onClick={onNextKeyParagraph}
        >
          <ArrowDownIcon className="size-3.5" />
          <T>Next key</T>
        </Button>

        {figures.length > 0 ? (
          <Select
            value=""
            onValueChange={(figureId) => {
              const target = figures.find((fig) => fig.id === figureId);
              if (target) onJumpToPage(target.physicalPage, target.paragraphKey);
            }}
          >
            <SelectTrigger aria-label={gt("Jump to figure or table")} size="sm">
              <ImageIcon className="size-3.5" />
              <SelectValue placeholder={gt("Figures")} />
            </SelectTrigger>
            <SelectPopup>
              {figures.map((fig) => (
                <SelectItem key={fig.id} value={fig.id}>
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="font-medium">{fig.label}</span>
                    <span className="text-muted-foreground tabular-nums">p.{fig.physicalPage}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}

        <Button
          size="xs"
          variant={muddiestCount > 0 ? "secondary" : "ghost"}
          onClick={onOpenMuddiestList}
        >
          <HelpCircleIcon className="size-3.5" />
          <T>
            Muddiest (<Var>{muddiestCount}</Var>)
          </T>
        </Button>

        <Button
          aria-label={gt("Toggle split or right-only rails")}
          size="xs"
          title={layoutMode === "split" ? gt("Split left & right rails") : gt("Right-only rail")}
          variant="ghost"
          onClick={() => onChangeLayoutMode(layoutMode === "split" ? "right" : "split")}
        >
          <Columns2Icon className="size-3.5" />
          {layoutMode === "split" ? <T>Split rails</T> : <T>Right rail</T>}
        </Button>

        <Button
          aria-label={gt("Toggle margin rails")}
          size="xs"
          variant={railCollapsed ? "secondary" : "ghost"}
          onClick={onToggleRailCollapsed}
        >
          <EyeOffIcon className="size-3.5" />
          {railCollapsed ? <T>Show rails</T> : <T>Hide rails</T>}
        </Button>

        <Button
          aria-label={gt("Toggle focus mode")}
          size="xs"
          variant={focusMode ? "secondary" : "ghost"}
          onClick={onToggleFocusMode}
        >
          <FocusIcon className="size-3.5" />
          <T>Focus</T>
        </Button>

        <div className="hidden items-center gap-0.5 rounded-md border px-1 py-0.5 sm:flex">
          <Button
            aria-label={gt("Zoom out")}
            size="xs"
            variant="ghost"
            onClick={() => onStepZoom(-15)}
          >
            <MinusIcon className="size-3" />
          </Button>
          <span className="px-1 tabular-nums">{zoomPct}%</span>
          <Button
            aria-label={gt("Zoom in")}
            size="xs"
            variant="ghost"
            onClick={() => onStepZoom(15)}
          >
            <PlusIcon className="size-3" />
          </Button>
        </div>

        <Button
          aria-label={gt("Toggle reading workbench panel")}
          size="xs"
          variant={panelOpen ? "secondary" : "outline"}
          onClick={onTogglePanel}
        >
          <PanelRightIcon className="size-3.5" />
          <T>Workbench</T>
        </Button>
      </div>
    </div>
  );
}

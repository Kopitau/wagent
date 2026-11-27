import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  LibraryEntry,
  LibraryImaSearchHit,
  LibraryReadingParagraphContract,
  ProjectId,
} from "@t3tools/contracts";
import {
  detectContinuationCandidates,
  findNextKeyParagraph,
  type PaperParagraphBlock,
  type RailLayoutMode,
  type ReadingDepthMode,
  type WkbAnnotationKind,
} from "@t3tools/research-library/reader";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, Var } from "gt-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { toastManager } from "~/components/ui/toast";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { m } from "~/i18n/messages";
import { useProjects } from "~/state/entities";
import {
  libraryEnvironment,
  useLibraryImaStatus,
  useLibraryList,
  useLibraryReadingModels,
  useLibraryReadingState,
  useLibraryWkbStatus,
} from "~/state/library";
import { useAtomCommand } from "~/state/use-atom-command";

import { DeepReadMarginRail } from "./DeepReadMarginRail";
import { DeepReadPanels, type DeepReadPanelTab } from "./DeepReadPanels";
import { DeepReadPdfStage } from "./DeepReadPdfStage";
import { DeepReadStructureBar } from "./DeepReadStructureBar";
import "./deepread.css";
import {
  buildDocumentPages,
  buildFallbackPageParagraphs,
  extractDocumentStructure,
  parseParagraphAnalysis,
  parsePreferences,
  shouldHighlightParagraph,
  shouldIgnoreReaderShortcut,
} from "./deepreadHelpers";

export interface DeepReadWorkbenchProps {
  readonly environmentId: EnvironmentId;
  readonly entry: LibraryEntry;
}

function commandFailureText(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    return errorDisplayMessage(cause, m) ?? (cause.message || fallback);
  }
  return fallback;
}

export function DeepReadWorkbench({ environmentId, entry }: DeepReadWorkbenchProps) {
  const gt = useGT();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const allProjects = useProjects();
  const envProjects = allProjects.filter((project) => project.environmentId === environmentId);

  const canWrite = useAtomValue(
    libraryEnvironment.upsertReadingParagraph.permissionAtom(environmentId),
  );
  const canManageIma = useAtomValue(
    libraryEnvironment.updateImaConfig.permissionAtom(environmentId),
  );

  const readingStateQuery = useLibraryReadingState(environmentId, entry.id, true);
  const readingModelsQuery = useLibraryReadingModels(environmentId, true);
  const wkbStatusQuery = useLibraryWkbStatus(environmentId, true);
  const imaStatusQuery = useLibraryImaStatus(environmentId, true);
  const libraryListQuery = useLibraryList(environmentId, { limit: 100, offset: 0 }, true);

  const loadPdfBytesCommand = useAtomCommand(libraryEnvironment.loadPdfBytes, {
    reportFailure: false,
  });
  const setPositionCommand = useAtomCommand(libraryEnvironment.setReadingPosition, {
    reportFailure: false,
  });
  const upsertParagraphCommand = useAtomCommand(libraryEnvironment.upsertReadingParagraph, {
    reportFailure: false,
  });
  const deleteQuestionCommand = useAtomCommand(libraryEnvironment.deleteReadingQuestion, {
    reportFailure: false,
  });
  const setPreferenceCommand = useAtomCommand(libraryEnvironment.setReadingPreference, {
    reportFailure: false,
  });
  const runAiCommand = useAtomCommand(libraryEnvironment.runReadingAiAction, {
    reportFailure: false,
  });
  const importGuideCommand = useAtomCommand(libraryEnvironment.importGuide, {
    reportFailure: false,
  });
  const syncWkbCommand = useAtomCommand(libraryEnvironment.syncWkbAnnotations, {
    reportFailure: false,
  });
  const submitWkbCommand = useAtomCommand(libraryEnvironment.submitToWkb, {
    reportFailure: false,
  });
  const updateImaCommand = useAtomCommand(libraryEnvironment.updateImaConfig, {
    reportFailure: false,
  });
  const imaSearchCommand = useAtomCommand(libraryEnvironment.imaSearch, {
    reportFailure: false,
  });
  const composeDraftCommand = useAtomCommand(libraryEnvironment.composeDraft, {
    reportFailure: false,
  });

  const readingState = readingStateQuery.data ?? null;
  const serverPrefs = parsePreferences(readingState?.preferences ?? {});

  // Local immediate overrides so sliders, toggles, and page turns respond instantly.
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [positionInitializedFor, setPositionInitializedFor] = useState<string | null>(null);
  const [totalPagesOverride, setTotalPagesOverride] = useState<number | null>(null);
  const [stageHeightPx, setStageHeightPx] = useState<number>(920);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [panelOpen, setPanelOpen] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<DeepReadPanelTab>("guide");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(new Set());
  const [prefOverrides, setPrefOverrides] = useState<Readonly<Record<string, string>>>({});
  const [pdfParagraphsByPage, setPdfParagraphsByPage] = useState<
    Readonly<Record<number, ReadonlyArray<PaperParagraphBlock>>>
  >({});

  // AI & Q&A state with real AbortController cancellation
  const aiAbortRef = useRef<AbortController | null>(null);
  const [aiBusyLabel, setAiBusyLabel] = useState<string | null>(null);
  const [busyAnchor, setBusyAnchor] = useState<string | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string>("");
  const [askDraft, setAskDraft] = useState<string>("");
  const [askTargetBlock, setAskTargetBlock] = useState<PaperParagraphBlock | null>(null);
  const [wkbBusy, setWkbBusy] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [sendingToThread, setSendingToThread] = useState(false);

  // Sync persisted physical page once when entry readingState first arrives
  if (readingState && positionInitializedFor !== entry.id) {
    setPositionInitializedFor(entry.id);
    if (readingState.physicalPage >= 1) {
      setCurrentPage(readingState.physicalPage);
    }
  }

  const effectivePrefs = parsePreferences({
    ...readingState?.preferences,
    ...prefOverrides,
  });

  const docPages = buildDocumentPages(entry, readingState?.pages ?? []);
  const totalPages = Math.max(1, totalPagesOverride ?? 0, entry.pageCount, docPages.length);

  // Assemble all document paragraphs (PDF.js geometry when available, deterministic fallback otherwise)
  const allParagraphs: PaperParagraphBlock[] = [];
  for (const page of docPages) {
    const resolved = pdfParagraphsByPage[page.physicalPage];
    if (resolved && resolved.length > 0) {
      allParagraphs.push(...resolved);
    } else {
      allParagraphs.push(...buildFallbackPageParagraphs(page.physicalPage, page.text));
    }
  }
  const currentPageParagraphs =
    pdfParagraphsByPage[currentPage] ??
    allParagraphs.filter((block) => block.physicalPage === currentPage);

  const structure = extractDocumentStructure(docPages, allParagraphs);
  const continuations = detectContinuationCandidates(allParagraphs);

  const persistedParagraphs = readingState?.paragraphs ?? [];
  const persistedByAnchor = new Map<string, LibraryReadingParagraphContract>(
    persistedParagraphs.map((item) => [item.anchor, item]),
  );
  const persistedQuestions = readingState?.questions ?? [];
  const persistedInsights = readingState?.insights ?? [];

  const muddiestCount = persistedParagraphs.filter((p) => p.marked).length;

  const models = readingModelsQuery.data?.models ?? [];
  const effectiveModelKey =
    selectedModelKey || (models[0] ? `${models[0].instanceId}::${models[0].model}` : "");

  const hasPdf = entry.blobSha256 !== null;
  const libraryCandidates = (libraryListQuery.data?.items ?? [])
    .filter((item) => item.id !== entry.id)
    .map((item) => ({ id: item.id, title: item.title }));

  // Partition current-page cards into left vs right rails (`split` vs `right`)
  const visiblePageBlocks = currentPageParagraphs.filter((block) => !block.isHeading);
  const leftRailBlocks =
    effectivePrefs.layoutMode === "split"
      ? visiblePageBlocks.filter((block) => block.columnSide === "left")
      : [];
  const rightRailBlocks =
    effectivePrefs.layoutMode === "split"
      ? visiblePageBlocks.filter((block) => block.columnSide !== "left")
      : visiblePageBlocks;

  const persistPreference = (key: string, value: string) => {
    setPrefOverrides((prev) => ({ ...prev, [key]: value }));
    if (!canWrite) return;
    void setPreferenceCommand({
      environmentId,
      input: { scopeKey: key, valueJson: JSON.stringify(value) },
    });
  };

  const handleJumpToPage = (page: number, blockKey?: string) => {
    const clamped = Math.max(1, Math.min(totalPages, Math.floor(page)));
    setCurrentPage(clamped);
    if (blockKey) {
      setActiveKey(blockKey);
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        next.add(blockKey);
        return next;
      });
    }
    if (clamped > effectivePrefs.furthestPage) {
      persistPreference("furthestPage", String(clamped));
    }
    if (canWrite) {
      void setPositionCommand({
        environmentId,
        input: { entryId: entry.id, physicalPage: clamped },
      });
    }
  };

  const handleNextKeyNavigation = (direction: "next" | "prev") => {
    const nextBlock = findNextKeyParagraph({
      paragraphs: allParagraphs,
      currentKey: activeKey,
      direction,
      depthMode: effectivePrefs.depthMode,
      keyPredicate: (block) => {
        const persisted = persistedByAnchor.get(block.anchor);
        const analysis = parseParagraphAnalysis(persisted?.analysisJson);
        return (
          Boolean(persisted?.marked) ||
          Boolean(persisted?.note?.trim()) ||
          shouldHighlightParagraph(effectivePrefs.highlightDensity, persisted, analysis) ||
          (analysis !== null && analysis.importance >= 4)
        );
      },
    });
    if (!nextBlock) return;
    handleJumpToPage(nextBlock.physicalPage, nextBlock.key);
  };

  // Global keyboard shortcuts: N / Shift+N for next/prev key paragraph (strictly guarded against IME & inputs)
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Registers DeepRead N / Shift+N reader navigation shortcut with IME and input guard.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreReaderShortcut(event)) return;
      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        handleNextKeyNavigation(event.shiftKey ? "prev" : "next");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Cancel any in-flight AI action if the workbench unmounts
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Aborts in-flight AI reading RPC on unmount so no orphan requests persist.
  useEffect(() => {
    return () => {
      aiAbortRef.current?.abort();
    };
  }, []);

  const loadPdfBytes = async (
    signal: AbortSignal,
    options: { readonly reload: boolean },
  ): Promise<ArrayBuffer> => {
    const result = await loadPdfBytesCommand({
      environmentId,
      input: {
        entryId: entry.id,
        signal,
        reload: options.reload,
      },
    });
    if (result._tag === "Failure") {
      throw new Error(
        commandFailureText(squashAtomCommandFailure(result), m(msg("Unable to open PDF."))),
      );
    }
    return result.value;
  };

  const resolveSelectedModelParams = (): {
    readonly instanceId?: string | undefined;
    readonly model?: string | undefined;
  } => {
    if (!effectiveModelKey) return {};
    const sep = effectiveModelKey.indexOf("::");
    if (sep <= 0) return {};
    return {
      instanceId: effectiveModelKey.slice(0, sep),
      model: effectiveModelKey.slice(sep + 2),
    };
  };

  const executeReadingAi = async (input: {
    readonly label: string;
    readonly action:
      | "analyze_paragraph"
      | "summary5"
      | "quiz5"
      | "guide"
      | "figure_explain"
      | "ask_question";
    readonly physicalPage?: number | undefined;
    readonly anchor?: string | undefined;
    readonly quote?: string | undefined;
    readonly figureLabel?: string | undefined;
    readonly question?: string | undefined;
  }) => {
    if (!canWrite) return;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiBusyLabel(input.label);
    if (input.anchor) setBusyAnchor(input.anchor);

    const modelParams = resolveSelectedModelParams();
    const result = await runAiCommand(
      {
        environmentId,
        input: {
          entryId: entry.id,
          action: input.action,
          ...(input.physicalPage !== undefined ? { physicalPage: input.physicalPage } : {}),
          ...(input.anchor ? { anchor: input.anchor } : {}),
          ...(input.quote ? { quote: input.quote } : {}),
          ...(input.figureLabel ? { figureLabel: input.figureLabel } : {}),
          ...(input.question ? { question: input.question } : {}),
          ...(modelParams.instanceId ? { instanceId: modelParams.instanceId } : {}),
          ...(modelParams.model ? { model: modelParams.model } : {}),
        },
      },
      { signal: controller.signal },
    );

    if (aiAbortRef.current === controller) {
      aiAbortRef.current = null;
      setAiBusyLabel(null);
      setBusyAnchor(null);
    }

    if (controller.signal.aborted) {
      toastManager.add({
        type: "info",
        title: m(msg("AI reading cancelled")),
        description: m(msg("Cancelled before completion. Nothing was persisted.")),
      });
      return;
    }

    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("AI reading action failed")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("Could not complete AI reading action.")),
        ),
      });
      return;
    }

    if (input.action === "ask_question") {
      setAskDraft("");
      setAskTargetBlock(null);
    }
  };

  const handleCancelAiAction = () => {
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    setAiBusyLabel(null);
    setBusyAnchor(null);
  };

  const handleSaveParagraphPatch = async (input: {
    readonly block: PaperParagraphBlock;
    readonly note?: string | undefined;
    readonly marked?: boolean | undefined;
    readonly highlighted?: boolean | undefined;
    readonly wkbKind?: WkbAnnotationKind | undefined;
  }) => {
    if (!canWrite) return;
    const existing = persistedByAnchor.get(input.block.anchor);
    const result = await upsertParagraphCommand({
      environmentId,
      input: {
        entryId: entry.id,
        physicalPage: input.block.physicalPage,
        anchor: input.block.anchor,
        quote: input.block.text,
        ...(input.note !== undefined
          ? { note: input.note }
          : existing?.note !== undefined
            ? { note: existing.note }
            : {}),
        ...(input.marked !== undefined
          ? { marked: input.marked }
          : existing?.marked !== undefined
            ? { marked: existing.marked }
            : {}),
        ...(input.highlighted !== undefined
          ? { highlighted: input.highlighted }
          : existing?.highlighted !== undefined
            ? { highlighted: existing.highlighted }
            : {}),
        ...(input.wkbKind !== undefined
          ? { wkbKind: input.wkbKind }
          : existing?.wkbKind
            ? { wkbKind: existing.wkbKind as WkbAnnotationKind }
            : {}),
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("Could not save reading annotation")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("Failed to save paragraph note.")),
        ),
      });
    }
  };

  const handleMergeContinuation = async (lead: PaperParagraphBlock, tail: PaperParagraphBlock) => {
    if (!canWrite) return;
    const leadPersisted = persistedByAnchor.get(lead.anchor);
    const tailPersisted = persistedByAnchor.get(tail.anchor);
    const mergedQuote = `${lead.text}\n${tail.text}`;
    const mergedNote = [leadPersisted?.note?.trim(), tailPersisted?.note?.trim()]
      .filter(Boolean)
      .join("\n");
    const result = await upsertParagraphCommand({
      environmentId,
      input: {
        entryId: entry.id,
        physicalPage: lead.physicalPage,
        anchor: lead.anchor,
        quote: mergedQuote,
        note: mergedNote,
      },
    });
    if (result._tag === "Success") {
      setHiddenKeys((prev) => {
        const next = new Set(prev);
        next.add(tail.key);
        return next;
      });
      toastManager.add({
        type: "success",
        title: m(msg("Merged continuation paragraph")),
      });
    }
  };

  const handleImportGuide = async (content: string): Promise<boolean> => {
    if (!canWrite) return false;
    const result = await importGuideCommand({
      environmentId,
      input: { entryId: entry.id, content },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("Guide import failed")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("Could not parse DeepRead Guide.")),
        ),
      });
      return false;
    }
    toastManager.add({
      type: "success",
      title: m(msg("DeepRead Guide imported")),
    });
    return true;
  };

  const handleSyncWkbAnnotations = async (slug?: string) => {
    if (!canWrite || wkbBusy) return;
    setWkbBusy(true);
    const result = await syncWkbCommand({
      environmentId,
      input: {
        entryId: entry.id,
        sourceId: slug || entry.id,
      },
    });
    setWkbBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("wkb annotation sync failed")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("Unable to sync annotations to wkb brain.")),
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: m(msg("Synced annotations to wkb brain")),
      description: gt("Synced {count} annotations ({mode}).", {
        count: result.value.syncedCount,
        mode: result.value.mode,
      }),
    });
  };

  const handleSubmitToWkb = async (note?: string) => {
    if (!canWrite || wkbBusy) return;
    setWkbBusy(true);
    const result = await submitWkbCommand({
      environmentId,
      input: {
        entryId: entry.id,
        ...(note ? { note } : {}),
      },
    });
    setWkbBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("wkb submission failed")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("Unable to submit entry to wkb brain.")),
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: m(msg("Submitted to wkb brain")),
      description: result.value.summary || undefined,
    });
  };

  const handleUpdateImaConfig = async (input: {
    readonly enabled?: boolean | undefined;
    readonly baseUrl?: string | undefined;
    readonly knowledgeBaseId?: string | undefined;
    readonly apiKey?: string | null | undefined;
  }): Promise<boolean> => {
    const result = await updateImaCommand({
      environmentId,
      input,
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("Could not update ima settings")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("Failed to save ima settings.")),
        ),
      });
      return false;
    }
    toastManager.add({
      type: "success",
      title: m(msg("ima settings saved")),
    });
    return true;
  };

  const handleSearchIma = async (query: string): Promise<ReadonlyArray<LibraryImaSearchHit>> => {
    const result = await imaSearchCommand({
      environmentId,
      input: { query, limit: 8 },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("ima search failed")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("Could not query ima knowledge base.")),
        ),
      });
      return [];
    }
    return result.value.hits;
  };

  const handleSendToT3Thread = async (question: string) => {
    const targetProject =
      envProjects.find((p) => p.id === selectedProjectId) ?? envProjects[0] ?? null;
    if (!targetProject || sendingToThread) return;
    setSendingToThread(true);
    const draftRes = await composeDraftCommand({
      environmentId,
      input: {
        entryIds: [entry.id],
        question,
      },
    });
    setSendingToThread(false);
    if (draftRes._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("Could not compose T3 thread draft")),
        description: commandFailureText(
          squashAtomCommandFailure(draftRes),
          m(msg("Failed to build library draft context.")),
        ),
      });
      return;
    }
    await handleNewThread(
      { environmentId, projectId: targetProject.id },
      { prompt: draftRes.value.prompt },
    );
  };

  const handleDeleteQuestion = async (questionId: string) => {
    if (!canWrite) return;
    await deleteQuestionCommand({
      environmentId,
      input: { entryId: entry.id, questionId },
    });
  };

  const workbenchVars = {
    "--dr-card-font-size": `${effectivePrefs.cardFontSize}px`,
    "--dr-rail-width": `${effectivePrefs.railWidth}px`,
  } as CSSProperties;

  const showRails = !effectivePrefs.railCollapsed && !effectivePrefs.focusMode;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-deepread="workbench"
      data-testid="deepread-workbench"
      style={workbenchVars}
    >
      <DeepReadStructureBar
        currentPage={currentPage}
        depthMode={effectivePrefs.depthMode}
        estimatedMinutes={structure.estimatedMinutes}
        figures={structure.figures}
        focusMode={effectivePrefs.focusMode}
        furthestPage={Math.max(effectivePrefs.furthestPage, currentPage)}
        layoutMode={effectivePrefs.layoutMode}
        muddiestCount={muddiestCount}
        panelOpen={panelOpen}
        railCollapsed={effectivePrefs.railCollapsed}
        sections={structure.sections}
        totalPages={totalPages}
        zoomPct={zoomPct}
        onChangeDepthMode={(mode: ReadingDepthMode) => persistPreference("depthMode", mode)}
        onChangeLayoutMode={(mode: RailLayoutMode) => persistPreference("layoutMode", mode)}
        onJumpToPage={handleJumpToPage}
        onNextKeyParagraph={() => handleNextKeyNavigation("next")}
        onOpenMuddiestList={() => {
          setPanelOpen(true);
          setActiveTab("notes");
        }}
        onStepZoom={(delta) => setZoomPct((prev) => Math.max(70, Math.min(180, prev + delta)))}
        onToggleFocusMode={() =>
          persistPreference("focusMode", effectivePrefs.focusMode ? "false" : "true")
        }
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        onToggleRailCollapsed={() =>
          persistPreference("railCollapsed", effectivePrefs.railCollapsed ? "false" : "true")
        }
      />

      {/* Main dual-column workbench body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-h-0 flex-1 overflow-auto p-4 scrollbar-gutter-both">
          <div className="mx-auto flex w-max min-w-full items-start justify-center gap-4">
            {showRails && effectivePrefs.layoutMode === "split" ? (
              <DeepReadMarginRail
                activeKey={activeKey}
                busyAnchor={busyAnchor}
                canWrite={canWrite}
                continuations={continuations}
                expandedKeys={expandedKeys}
                hiddenKeys={hiddenKeys}
                keepExpanded={effectivePrefs.keepExpanded}
                paragraphs={leftRailBlocks}
                persistedByAnchor={persistedByAnchor}
                railWidthPx={effectivePrefs.railWidth}
                side="left"
                stageHeightPx={stageHeightPx}
                onAnalyzeParagraph={(block) => {
                  void executeReadingAi({
                    label: gt("Analyzing paragraph {label}...", { label: block.label }),
                    action: "analyze_paragraph",
                    physicalPage: block.physicalPage,
                    anchor: block.anchor,
                    quote: block.text,
                  });
                }}
                onAskParagraph={(block) => {
                  setAskTargetBlock(block);
                  setPanelOpen(true);
                  setActiveTab("ask");
                }}
                onExplainFigure={(block) => {
                  void executeReadingAi({
                    label: gt("Explaining {figure}...", {
                      figure: block.figureLabel ?? block.label,
                    }),
                    action: "figure_explain",
                    physicalPage: block.physicalPage,
                    anchor: block.anchor,
                    quote: block.text,
                    figureLabel: block.figureLabel ?? undefined,
                  });
                }}
                onHideCard={(key) =>
                  setHiddenKeys((prev) => {
                    const next = new Set(prev);
                    next.add(key);
                    return next;
                  })
                }
                onMergeContinuation={(lead, tail) => {
                  void handleMergeContinuation(lead, tail);
                }}
                onSaveParagraphPatch={(patch) => {
                  void handleSaveParagraphPatch(patch);
                }}
                onSelectParagraph={(block) => setActiveKey(block.key)}
                onToggleExpand={(key) =>
                  setExpandedKeys((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              />
            ) : null}

            <DeepReadPdfStage
              activeKey={activeKey}
              currentPage={currentPage}
              depthMode={effectivePrefs.depthMode}
              entry={entry}
              figures={structure.figures}
              hasPdf={hasPdf}
              highlightDensity={effectivePrefs.highlightDensity}
              libraryCandidates={libraryCandidates}
              loadPdfBytes={loadPdfBytes}
              paragraphs={currentPageParagraphs}
              persistedByAnchor={persistedByAnchor}
              references={structure.references}
              zoomPct={zoomPct}
              onJumpToPage={handleJumpToPage}
              onOpenLibraryEntry={(targetEntryId) => {
                void navigate({
                  to: "/library/$itemId",
                  params: { itemId: targetEntryId },
                  search: { env: environmentId },
                });
              }}
              onPageHeightResolved={(heightPx) => setStageHeightPx(Math.max(720, heightPx))}
              onPageParagraphsResolved={(pageNum, blocks) => {
                setPdfParagraphsByPage((prev) => ({
                  ...prev,
                  [pageNum]: blocks,
                }));
              }}
              onSelectParagraph={(block) => {
                setActiveKey(block.key);
                setExpandedKeys((prev) => {
                  const next = new Set(prev);
                  next.add(block.key);
                  return next;
                });
              }}
              onTotalPagesResolved={(count) => setTotalPagesOverride(count)}
            />

            {showRails ? (
              <DeepReadMarginRail
                activeKey={activeKey}
                busyAnchor={busyAnchor}
                canWrite={canWrite}
                continuations={continuations}
                expandedKeys={expandedKeys}
                hiddenKeys={hiddenKeys}
                keepExpanded={effectivePrefs.keepExpanded}
                paragraphs={rightRailBlocks}
                persistedByAnchor={persistedByAnchor}
                railWidthPx={effectivePrefs.railWidth}
                side="right"
                stageHeightPx={stageHeightPx}
                onAnalyzeParagraph={(block) => {
                  void executeReadingAi({
                    label: gt("Analyzing paragraph {label}...", { label: block.label }),
                    action: "analyze_paragraph",
                    physicalPage: block.physicalPage,
                    anchor: block.anchor,
                    quote: block.text,
                  });
                }}
                onAskParagraph={(block) => {
                  setAskTargetBlock(block);
                  setPanelOpen(true);
                  setActiveTab("ask");
                }}
                onExplainFigure={(block) => {
                  void executeReadingAi({
                    label: gt("Explaining {figure}...", {
                      figure: block.figureLabel ?? block.label,
                    }),
                    action: "figure_explain",
                    physicalPage: block.physicalPage,
                    anchor: block.anchor,
                    quote: block.text,
                    figureLabel: block.figureLabel ?? undefined,
                  });
                }}
                onHideCard={(key) =>
                  setHiddenKeys((prev) => {
                    const next = new Set(prev);
                    next.add(key);
                    return next;
                  })
                }
                onMergeContinuation={(lead, tail) => {
                  void handleMergeContinuation(lead, tail);
                }}
                onSaveParagraphPatch={(patch) => {
                  void handleSaveParagraphPatch(patch);
                }}
                onSelectParagraph={(block) => setActiveKey(block.key)}
                onToggleExpand={(key) =>
                  setExpandedKeys((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              />
            ) : null}
          </div>
        </div>

        {panelOpen && !effectivePrefs.focusMode ? (
          <DeepReadPanels
            activeTab={activeTab}
            aiBusyLabel={aiBusyLabel}
            askDraft={askDraft}
            askTargetBlock={askTargetBlock}
            canManageIma={canManageIma}
            canWrite={canWrite}
            hiddenCardCount={hiddenKeys.size}
            imaStatus={imaStatusQuery.data ?? null}
            insights={persistedInsights}
            models={models}
            paragraphs={persistedParagraphs}
            preferences={effectivePrefs}
            projects={envProjects.map((p) => ({ id: p.id, name: p.title }))}
            questions={persistedQuestions}
            selectedModelKey={effectiveModelKey}
            selectedProjectId={selectedProjectId ?? envProjects[0]?.id ?? null}
            sendingToThread={sendingToThread}
            wkbBusy={wkbBusy}
            wkbStatus={wkbStatusQuery.data ?? null}
            onCancelAiAction={handleCancelAiAction}
            onChangeAskDraft={setAskDraft}
            onChangeTab={setActiveTab}
            onClearAskTarget={() => setAskTargetBlock(null)}
            onDeleteQuestion={(id) => {
              void handleDeleteQuestion(id);
            }}
            onImportGuide={handleImportGuide}
            onJumpToPage={handleJumpToPage}
            onRestoreHiddenCards={() => setHiddenKeys(new Set())}
            onRunAskQuestion={() => {
              if (!askDraft.trim()) return;
              void executeReadingAi({
                label: gt("Answering document question..."),
                action: "ask_question",
                physicalPage: askTargetBlock?.physicalPage ?? currentPage,
                anchor: askTargetBlock?.anchor,
                quote: askTargetBlock?.text,
                question: askDraft.trim(),
              });
            }}
            onRunGuideAi={() => {
              void executeReadingAi({
                label: gt("Generating 5-stage DeepRead Guide..."),
                action: "guide",
                physicalPage: currentPage,
              });
            }}
            onRunQuiz5Ai={() => {
              void executeReadingAi({
                label: gt("Generating 5-question active-recall quiz..."),
                action: "quiz5",
                physicalPage: currentPage,
              });
            }}
            onRunSummary5Ai={() => {
              void executeReadingAi({
                label: gt("Generating 5-section skim summary..."),
                action: "summary5",
                physicalPage: currentPage,
              });
            }}
            onSearchIma={handleSearchIma}
            onSelectModelKey={setSelectedModelKey}
            onSelectProjectId={setSelectedProjectId}
            onSendToT3Thread={(question) => {
              void handleSendToT3Thread(question);
            }}
            onSubmitToWkb={(note) => {
              void handleSubmitToWkb(note);
            }}
            onSyncWkbAnnotations={(slug) => {
              void handleSyncWkbAnnotations(slug);
            }}
            onUpdateImaConfig={handleUpdateImaConfig}
            onUpdatePreference={persistPreference}
          />
        ) : null}
      </div>

      {/* Subtle status footer showing current reading goal when set */}
      {serverPrefs.readingGoal || effectivePrefs.readingGoal ? (
        <div className="border-t bg-background px-3 py-1 text-2xs text-muted-foreground">
          <T>
            Reading goal: <Var>{effectivePrefs.readingGoal}</Var>
          </T>
        </div>
      ) : null}
    </div>
  );
}

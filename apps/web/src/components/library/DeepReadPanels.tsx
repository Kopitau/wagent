import type {
  LibraryImaConfigView,
  LibraryImaSearchHit,
  LibraryReadingInsightContract,
  LibraryReadingModelOption,
  LibraryReadingParagraphContract,
  LibraryReadingQuestionContract,
  LibraryWkbStatusResult,
  ProjectId,
} from "@t3tools/contracts";
import {
  HIGHLIGHT_DENSITIES,
  type HighlightDensity,
  type PaperParagraphBlock,
} from "@t3tools/research-library/reader";
import { T, useGT, Var } from "gt-react";
import {
  BookOpenIcon,
  BotIcon,
  CheckCircle2Icon,
  CloudUploadIcon,
  DatabaseIcon,
  ListChecksIcon,
  LockIcon,
  MessageSquareIcon,
  SearchIcon,
  SendIcon,
  Settings2Icon,
  StopCircleIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";

import {
  parseAnchorRefTarget,
  parseGuideInsight,
  parseQuestionSources,
  parseQuiz5Insight,
  parseSummary5Insight,
  type DeepReadPreferencesState,
} from "./deepreadHelpers";

export type DeepReadPanelTab = "guide" | "skim" | "notes" | "ask" | "settings";

export interface DeepReadPanelsProps {
  readonly activeTab: DeepReadPanelTab;
  readonly onChangeTab: (tab: DeepReadPanelTab) => void;
  readonly insights: ReadonlyArray<LibraryReadingInsightContract>;
  readonly paragraphs: ReadonlyArray<LibraryReadingParagraphContract>;
  readonly questions: ReadonlyArray<LibraryReadingQuestionContract>;
  readonly models: ReadonlyArray<LibraryReadingModelOption>;
  readonly selectedModelKey: string;
  readonly onSelectModelKey: (key: string) => void;
  readonly preferences: DeepReadPreferencesState;
  readonly hiddenCardCount: number;
  readonly wkbStatus: LibraryWkbStatusResult | null;
  readonly imaStatus: LibraryImaConfigView | null;
  readonly canWrite: boolean;
  readonly canManageIma: boolean;
  readonly aiBusyLabel: string | null;
  readonly askDraft: string;
  readonly askTargetBlock: PaperParagraphBlock | null;
  readonly onChangeAskDraft: (text: string) => void;
  readonly onClearAskTarget: () => void;
  readonly onRunGuideAi: () => void;
  readonly onImportGuide: (content: string) => Promise<boolean>;
  readonly onRunSummary5Ai: () => void;
  readonly onRunQuiz5Ai: () => void;
  readonly onRunAskQuestion: () => void;
  readonly onCancelAiAction: () => void;
  readonly onDeleteQuestion: (questionId: string) => void;
  readonly onJumpToPage: (page: number, blockKey?: string) => void;
  readonly onSyncWkbAnnotations: (slug?: string) => void;
  readonly onSubmitToWkb: (note?: string) => void;
  readonly wkbBusy: boolean;
  readonly onUpdatePreference: (key: string, value: string) => void;
  readonly onRestoreHiddenCards: () => void;
  readonly onUpdateImaConfig: (input: {
    readonly enabled?: boolean | undefined;
    readonly baseUrl?: string | undefined;
    readonly knowledgeBaseId?: string | undefined;
    readonly apiKey?: string | null | undefined;
  }) => Promise<boolean>;
  readonly onSearchIma: (query: string) => Promise<ReadonlyArray<LibraryImaSearchHit>>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly name: string }>;
  readonly selectedProjectId: ProjectId | null;
  readonly onSelectProjectId: (id: ProjectId) => void;
  readonly onSendToT3Thread: (question: string) => void;
  readonly sendingToThread: boolean;
}

export function DeepReadPanels({
  activeTab,
  onChangeTab,
  insights,
  paragraphs,
  questions,
  models,
  selectedModelKey,
  onSelectModelKey,
  preferences,
  hiddenCardCount,
  wkbStatus,
  imaStatus,
  canWrite,
  canManageIma,
  aiBusyLabel,
  askDraft,
  askTargetBlock,
  onChangeAskDraft,
  onClearAskTarget,
  onRunGuideAi,
  onImportGuide,
  onRunSummary5Ai,
  onRunQuiz5Ai,
  onRunAskQuestion,
  onCancelAiAction,
  onDeleteQuestion,
  onJumpToPage,
  onSyncWkbAnnotations,
  onSubmitToWkb,
  wkbBusy,
  onUpdatePreference,
  onRestoreHiddenCards,
  onUpdateImaConfig,
  onSearchIma,
  projects,
  selectedProjectId,
  onSelectProjectId,
  onSendToT3Thread,
  sendingToThread,
}: DeepReadPanelsProps) {
  const gt = useGT();

  // Guide import state
  const [guideImportOpen, setGuideImportOpen] = useState(false);
  const [guideImportText, setGuideImportText] = useState("");

  // Active-recall state for 5-question self-test (write your own answer first, then reveal reference)
  const [recallDrafts, setRecallDrafts] = useState<Readonly<Record<string, string>>>({});
  const [revealedQuizKeys, setRevealedQuizKeys] = useState<ReadonlySet<string>>(new Set());

  // Reading goal local edit
  const [goalDraft, setGoalDraft] = useState(preferences.readingGoal);

  // wkb sync inputs
  const [wkbSlugInput, setWkbSlugInput] = useState("");
  const [wkbSubmitNote, setWkbSubmitNote] = useState("");

  // Send to T3 main thread prompt
  const [threadQuestion, setThreadQuestion] = useState("");

  // ima config + search state
  const [imaEnabled, setImaEnabled] = useState(imaStatus?.enabled ?? false);
  const [imaBaseUrl, setImaBaseUrl] = useState(imaStatus?.baseUrl ?? "");
  const [imaKbId, setImaKbId] = useState(imaStatus?.knowledgeBaseId ?? "");
  const [imaApiKey, setImaApiKey] = useState("");
  const [imaSaving, setImaSaving] = useState(false);
  const [imaQuery, setImaQuery] = useState("");
  const [imaSearching, setImaSearching] = useState(false);
  const [imaHits, setImaHits] = useState<ReadonlyArray<LibraryImaSearchHit>>([]);

  const guide = parseGuideInsight(insights);
  const summary5 = parseSummary5Insight(insights);
  const quiz5 = parseQuiz5Insight(insights);

  const muddiestParagraphs = paragraphs.filter((p) => p.marked);
  const annotatedParagraphs = paragraphs.filter((p) => p.note.trim().length > 0 || p.marked);

  const selectedModel =
    models.find((m) => `${m.instanceId}::${m.model}` === selectedModelKey) ?? models[0] ?? null;

  const jumpByAnchorRef = (ref: string) => {
    const parsed = parseAnchorRefTarget(ref);
    if (parsed) {
      onJumpToPage(parsed.physicalPage, parsed.blockKey ?? undefined);
    }
  };

  const handleImportGuideSubmit = async () => {
    if (!guideImportText.trim()) return;
    const ok = await onImportGuide(guideImportText);
    if (ok) {
      setGuideImportText("");
      setGuideImportOpen(false);
    }
  };

  const handleSaveIma = async () => {
    if (!canManageIma || imaSaving) return;
    setImaSaving(true);
    const ok = await onUpdateImaConfig({
      enabled: imaEnabled,
      baseUrl: imaBaseUrl,
      knowledgeBaseId: imaKbId,
      ...(imaApiKey.trim() ? { apiKey: imaApiKey.trim() } : {}),
    });
    setImaSaving(false);
    if (ok) {
      setImaApiKey("");
    }
  };

  const handleRunImaSearch = async () => {
    if (!imaQuery.trim() || imaSearching) return;
    setImaSearching(true);
    const hits = await onSearchIma(imaQuery.trim());
    setImaSearching(false);
    setImaHits(hits);
  };

  return (
    <aside
      aria-label={gt("DeepRead reading workbench")}
      className="flex w-96 shrink-0 flex-col border-l bg-background"
      data-testid="deepread-workbench-panel"
    >
      {/* Top tab strip */}
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-2">
        {(
          [
            { id: "guide", label: gt("Guide"), icon: BookOpenIcon },
            { id: "skim", label: gt("Skim & Quiz"), icon: ListChecksIcon },
            { id: "notes", label: gt("Notes & wkb"), icon: CloudUploadIcon },
            { id: "ask", label: gt("Ask"), icon: MessageSquareIcon },
            { id: "settings", label: gt("Settings"), icon: Settings2Icon },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          return (
            <Button
              key={tab.id}
              data-testid={`deepread-tab-${tab.id}`}
              size="xs"
              variant={activeTab === tab.id ? "secondary" : "ghost"}
              onClick={() => onChangeTab(tab.id)}
            >
              <Icon className="size-3.5" />
              {tab.label}
            </Button>
          );
        })}
      </div>

      {/* Global in-flight AI indicator with Cancel button (cancelling persists nothing!) */}
      {aiBusyLabel ? (
        <div
          className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-xs"
          data-testid="deepread-ai-busy-bar"
        >
          <span className="truncate font-medium">{aiBusyLabel}</span>
          <Button
            data-testid="deepread-ai-cancel-btn"
            size="xs"
            variant="destructive"
            onClick={onCancelAiAction}
          >
            <StopCircleIcon className="size-3.5" />
            <T>Cancel</T>
          </Button>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3 text-xs">
          {/* TAB 1: 5-Stage DeepRead v1.4.0 Guide */}
          {activeTab === "guide" ? (
            <div className="flex flex-col gap-3" data-testid="deepread-panel-guide">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-sm">
                  <T>5-Stage Paper Guide</T>
                </h2>
                <div className="flex items-center gap-1">
                  <Button
                    disabled={!canWrite || aiBusyLabel !== null}
                    size="xs"
                    variant="outline"
                    onClick={onRunGuideAi}
                  >
                    <BotIcon className="size-3.5" />
                    <T>AI Guide</T>
                  </Button>
                  <Button
                    disabled={!canWrite}
                    size="xs"
                    variant="ghost"
                    onClick={() => setGuideImportOpen(!guideImportOpen)}
                  >
                    <UploadIcon className="size-3.5" />
                    <T>Import</T>
                  </Button>
                </div>
              </div>

              {guideImportOpen ? (
                <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2.5">
                  <Textarea
                    aria-label={gt("Paste DeepRead Guide JSON or Markdown")}
                    data-testid="deepread-guide-import-input"
                    placeholder={gt("Paste DeepRead v1.4.0 Guide JSON or Markdown...")}
                    rows={5}
                    value={guideImportText}
                    onChange={(event) => setGuideImportText(event.target.value)}
                  />
                  <div className="flex items-center gap-1.5">
                    <Button
                      data-testid="deepread-guide-import-submit"
                      disabled={!guideImportText.trim()}
                      size="xs"
                      onClick={() => {
                        void handleImportGuideSubmit();
                      }}
                    >
                      <T>Import Guide</T>
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setGuideImportOpen(false)}>
                      <T>Cancel</T>
                    </Button>
                  </div>
                </div>
              ) : null}

              {guide ? (
                <div className="flex flex-col gap-3">
                  {/* Stage 1: Position */}
                  <section className="rounded-md border p-2.5">
                    <h3 className="mb-1 font-semibold">
                      <T>1. Position</T>
                    </h3>
                    {guide.position.claim ? <p className="mb-1.5">{guide.position.claim}</p> : null}
                    {guide.position.path && guide.position.path.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {guide.position.path.map((item) => (
                          <div key={`${item.step}:${item.text}`} className="flex flex-col gap-0.5">
                            <span className="font-medium text-muted-foreground">{item.step}</span>
                            <span>{item.text}</span>
                            {item.keys && item.keys.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {item.keys.map((k) => (
                                  <Button
                                    key={k}
                                    size="xs"
                                    variant="outline"
                                    onClick={() => jumpByAnchorRef(k)}
                                  >
                                    {k}
                                  </Button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </section>

                  {/* Stage 2: Skeleton */}
                  <section className="rounded-md border p-2.5">
                    <h3 className="mb-1 font-semibold">
                      <T>2. Skeleton</T>
                    </h3>
                    {guide.skeleton.moves && guide.skeleton.moves.length > 0 ? (
                      <ul className="flex flex-col gap-1.5">
                        {guide.skeleton.moves.map((move) => (
                          <li key={move.text} className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5">
                              {move.role ? (
                                <Badge size="sm" variant="secondary">
                                  {move.role}
                                </Badge>
                              ) : null}
                              <span>{move.text}</span>
                            </div>
                            {move.keys && move.keys.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {move.keys.map((k) => (
                                  <Button
                                    key={k}
                                    size="xs"
                                    variant="outline"
                                    onClick={() => jumpByAnchorRef(k)}
                                  >
                                    {k}
                                  </Button>
                                ))}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">
                        <T>No skeleton moves recorded yet.</T>
                      </p>
                    )}
                  </section>

                  {/* Stage 3: Method */}
                  <section className="rounded-md border p-2.5">
                    <h3 className="mb-1 font-semibold">
                      <T>3. Method</T>
                    </h3>
                    {guide.method.insight?.core ? (
                      <p className="mb-1.5 font-medium">{guide.method.insight.core}</p>
                    ) : null}
                    {guide.method.components && guide.method.components.length > 0 ? (
                      <ul className="flex flex-col gap-1">
                        {guide.method.components.map((comp) => (
                          <li key={comp.name} className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium">{comp.name}</span>
                              {comp.verdict ? (
                                <Badge size="sm" variant="outline">
                                  {comp.verdict}
                                </Badge>
                              ) : null}
                            </div>
                            {comp.basis ? (
                              <span className="text-muted-foreground">{comp.basis}</span>
                            ) : null}
                            {comp.keys && comp.keys.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {comp.keys.map((k) => (
                                  <Button
                                    key={k}
                                    size="xs"
                                    variant="outline"
                                    onClick={() => jumpByAnchorRef(k)}
                                  >
                                    {k}
                                  </Button>
                                ))}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>

                  {/* Stage 4: Evidence */}
                  <section className="rounded-md border p-2.5">
                    <h3 className="mb-1 font-semibold">
                      <T>4. Evidence</T>
                    </h3>
                    {guide.evidence.chain && guide.evidence.chain.length > 0 ? (
                      <ul className="flex flex-col gap-1.5">
                        {guide.evidence.chain.map((item) => (
                          <li
                            key={`${item.claim}:${item.evidence}`}
                            className="flex flex-col gap-1"
                          >
                            <span className="font-medium">{item.claim}</span>
                            <span className="text-muted-foreground">{item.evidence}</span>
                            {item.keys && item.keys.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {item.keys.map((k) => (
                                  <Button
                                    key={k}
                                    size="xs"
                                    variant="outline"
                                    onClick={() => jumpByAnchorRef(k)}
                                  >
                                    {k}
                                  </Button>
                                ))}
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground">
                        <T>No evidence chains recorded yet.</T>
                      </p>
                    )}
                  </section>

                  {/* Stage 5: Takeaway */}
                  <section className="rounded-md border p-2.5">
                    <h3 className="mb-1 font-semibold">
                      <T>5. Takeaway</T>
                    </h3>
                    {guide.takeaway.summary ? (
                      <p className="mb-1">{guide.takeaway.summary}</p>
                    ) : null}
                    {guide.takeaway.learned && guide.takeaway.learned.length > 0 ? (
                      <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                        {guide.takeaway.learned.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                </div>
              ) : (
                <div className="rounded-md border border-dashed p-4 text-center text-muted-foreground">
                  <p>
                    <T>
                      Generate a 5-stage DeepRead Guide with AI or import a DeepRead JSON/Markdown
                      guide.
                    </T>
                  </p>
                </div>
              )}
            </div>
          ) : null}

          {/* TAB 2: 5-Section Skim + 5-Question Active-Recall Self-Test */}
          {activeTab === "skim" ? (
            <div className="flex flex-col gap-4" data-testid="deepread-panel-skim">
              {/* Reading Goal */}
              <div className="flex flex-col gap-1.5 rounded-md border p-2.5">
                <span className="font-semibold">
                  <T>Reading goal</T>
                </span>
                <div className="flex items-center gap-1.5">
                  <Input
                    aria-label={gt("Reading goal")}
                    placeholder={gt("What do you want to extract from this paper?")}
                    value={goalDraft}
                    onChange={(event) => setGoalDraft(event.target.value)}
                  />
                  <Button
                    disabled={!canWrite}
                    size="xs"
                    variant="outline"
                    onClick={() => onUpdatePreference("readingGoal", goalDraft.trim())}
                  >
                    <T>Save</T>
                  </Button>
                </div>
              </div>

              {/* 5-Section Skim */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm">
                    <T>5-Section Skim</T>
                  </h2>
                  <Button
                    disabled={!canWrite || aiBusyLabel !== null}
                    size="xs"
                    variant="outline"
                    onClick={onRunSummary5Ai}
                  >
                    <BotIcon className="size-3.5" />
                    <T>Generate</T>
                  </Button>
                </div>
                {summary5 ? (
                  <div className="flex flex-col gap-2 rounded-md border p-2.5">
                    <div>
                      <span className="font-medium">
                        <T>Problem: </T>
                      </span>
                      <span>{summary5.problem}</span>
                    </div>
                    <div>
                      <span className="font-medium">
                        <T>Method: </T>
                      </span>
                      <span>{summary5.method}</span>
                    </div>
                    <div>
                      <span className="font-medium">
                        <T>Findings: </T>
                      </span>
                      <span>{summary5.findings}</span>
                    </div>
                    <div>
                      <span className="font-medium">
                        <T>Evidence: </T>
                      </span>
                      <span>{summary5.evidence}</span>
                    </div>
                    <div>
                      <span className="font-medium">
                        <T>Limitations: </T>
                      </span>
                      <span>{summary5.limitations}</span>
                    </div>
                    {summary5.citations.length > 0 ? (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {summary5.citations.map((cite) => (
                          <Button
                            key={`${cite.physicalPage}:${cite.quote}`}
                            size="xs"
                            variant="outline"
                            onClick={() => onJumpToPage(cite.physicalPage)}
                          >
                            <T>
                              p.<Var>{cite.physicalPage}</Var>
                            </T>
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    <T>Generate a concise 5-part overview anchored to physical page numbers.</T>
                  </p>
                )}
              </div>

              {/* 5-Question Active-Recall Self-Test */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm">
                    <T>5-Question Active Recall</T>
                  </h2>
                  <Button
                    disabled={!canWrite || aiBusyLabel !== null}
                    size="xs"
                    variant="outline"
                    onClick={onRunQuiz5Ai}
                  >
                    <BotIcon className="size-3.5" />
                    <T>Generate Quiz</T>
                  </Button>
                </div>
                {quiz5 && quiz5.items.length > 0 ? (
                  <div className="flex flex-col gap-2.5">
                    {quiz5.items.map((item) => {
                      const qKey = `${item.physicalPage}:${item.question}`;
                      const revealed = revealedQuizKeys.has(qKey);
                      const userRecall = recallDrafts[qKey] ?? "";
                      return (
                        <div key={qKey} className="flex flex-col gap-1.5 rounded-md border p-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium">{item.question}</p>
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => onJumpToPage(item.physicalPage)}
                            >
                              <T>
                                p.<Var>{item.physicalPage}</Var>
                              </T>
                            </Button>
                          </div>
                          <Textarea
                            aria-label={gt("Your explanation before revealing answer")}
                            placeholder={gt("Write your own explanation first...")}
                            rows={2}
                            value={userRecall}
                            onChange={(event) =>
                              setRecallDrafts((prev) => ({
                                ...prev,
                                [qKey]: event.target.value,
                              }))
                            }
                          />
                          <div>
                            <Button
                              size="xs"
                              variant={revealed ? "secondary" : "outline"}
                              onClick={() =>
                                setRevealedQuizKeys((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(qKey)) next.delete(qKey);
                                  else next.add(qKey);
                                  return next;
                                })
                              }
                            >
                              {revealed ? (
                                <T>Hide reference answer</T>
                              ) : (
                                <T>Reveal reference answer</T>
                              )}
                            </Button>
                          </div>
                          {revealed ? (
                            <div className="rounded-md bg-muted/40 p-2 text-muted-foreground">
                              <p>{item.answer}</p>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    <T>
                      Test your understanding by answering in your own words before checking
                      answers.
                    </T>
                  </p>
                )}
              </div>
            </div>
          ) : null}

          {/* TAB 3: Muddiest Points, Personal Notes & wkb brain Sync */}
          {activeTab === "notes" ? (
            <div className="flex flex-col gap-4" data-testid="deepread-panel-notes">
              {/* wkb brain Sync Controls */}
              <section className="flex flex-col gap-2 rounded-md border p-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm">
                    <T>Sync to wkb brain</T>
                  </h2>
                  <Badge
                    size="sm"
                    variant={
                      (wkbStatus?.syncAvailable ?? wkbStatus?.available) ? "secondary" : "outline"
                    }
                  >
                    {(wkbStatus?.syncAvailable ?? wkbStatus?.available) ? (
                      <T>
                        Connected (<Var>{wkbStatus?.mode ?? "local"}</Var>)
                      </T>
                    ) : (
                      <T>Unavailable</T>
                    )}
                  </Badge>
                </div>
                <Input
                  aria-label={gt("Optional wkb target slug")}
                  placeholder={gt("Optional wkb note slug (auto-matched if blank)")}
                  value={wkbSlugInput}
                  onChange={(event) => setWkbSlugInput(event.target.value)}
                />
                <Button
                  data-testid="deepread-sync-wkb-btn"
                  disabled={
                    !canWrite ||
                    wkbBusy ||
                    annotatedParagraphs.length === 0 ||
                    !(wkbStatus?.syncAvailable ?? wkbStatus?.available)
                  }
                  size="xs"
                  onClick={() => onSyncWkbAnnotations(wkbSlugInput.trim() || undefined)}
                >
                  <CloudUploadIcon className="size-3.5" />
                  <T>
                    Sync <Var>{annotatedParagraphs.length}</Var> annotations to wkb brain
                  </T>
                </Button>
                <Textarea
                  aria-label={gt("Optional submission summary note")}
                  placeholder={gt(
                    "Optional summary note when submitting full entry to wkb brain...",
                  )}
                  rows={2}
                  value={wkbSubmitNote}
                  onChange={(event) => setWkbSubmitNote(event.target.value)}
                />
                <Button
                  data-testid="deepread-submit-wkb-btn"
                  disabled={
                    !canWrite || wkbBusy || !(wkbStatus?.syncAvailable ?? wkbStatus?.available)
                  }
                  size="xs"
                  variant="outline"
                  onClick={() => onSubmitToWkb(wkbSubmitNote.trim() || undefined)}
                >
                  <CheckCircle2Icon className="size-3.5" />
                  <T>Submit full paper & notes to wkb brain</T>
                </Button>
              </section>

              {/* Muddiest Points */}
              <section className="flex flex-col gap-2">
                <h3 className="font-semibold">
                  <T>
                    Muddiest points (<Var>{muddiestParagraphs.length}</Var>)
                  </T>
                </h3>
                {muddiestParagraphs.length === 0 ? (
                  <p className="text-muted-foreground">
                    <T>No muddiest points marked yet.</T>
                  </p>
                ) : (
                  muddiestParagraphs.map((para) => (
                    <div key={para.anchor} className="flex flex-col gap-1 rounded-md border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <Badge size="sm" variant="secondary">
                          {para.wkbKind}
                        </Badge>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => onJumpToPage(para.physicalPage)}
                        >
                          <T>
                            p.<Var>{para.physicalPage}</Var>
                          </T>
                        </Button>
                      </div>
                      <p className="line-clamp-3 text-muted-foreground">{para.quote}</p>
                      {para.note ? <p className="font-medium">{para.note}</p> : null}
                    </div>
                  ))
                )}
              </section>

              {/* All Notes */}
              <section className="flex flex-col gap-2">
                <h3 className="font-semibold">
                  <T>
                    All paragraph notes (<Var>{annotatedParagraphs.length}</Var>)
                  </T>
                </h3>
                {annotatedParagraphs.map((para) => (
                  <div
                    key={`note:${para.anchor}`}
                    className="flex flex-col gap-1"
                    data-deepread="note-box"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge size="sm" variant="outline">
                        {para.wkbKind}
                      </Badge>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => onJumpToPage(para.physicalPage)}
                      >
                        <T>
                          p.<Var>{para.physicalPage}</Var>
                        </T>
                      </Button>
                    </div>
                    {para.note ? <p className="whitespace-pre-wrap">{para.note}</p> : null}
                    <p className="line-clamp-2 text-2xs text-muted-foreground">{para.quote}</p>
                  </div>
                ))}
              </section>
            </div>
          ) : null}

          {/* TAB 4: Document AI Q&A + Dual-Route Model Picker + Send to T3 Main Thread */}
          {activeTab === "ask" ? (
            <div className="flex flex-col gap-4" data-testid="deepread-panel-ask">
              {/* Model Selector showing explicit Direct API vs CLI Subscription route badge */}
              <section className="flex flex-col gap-1.5 rounded-md border p-2.5">
                <span className="font-semibold">
                  <T>Reading AI model</T>
                </span>
                {models.length > 0 ? (
                  <>
                    <Select
                      value={selectedModelKey}
                      onValueChange={(next) => next && onSelectModelKey(next)}
                    >
                      <SelectTrigger aria-label={gt("Select reading AI model")} size="sm">
                        <SelectValue>
                          {selectedModel
                            ? `${selectedModel.providerLabel} · ${selectedModel.label}`
                            : gt("Select model")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {models.map((opt) => {
                          const key = `${opt.instanceId}::${opt.model}`;
                          return (
                            <SelectItem key={key} value={key}>
                              <span className="flex w-full items-center justify-between gap-2">
                                <span>
                                  {opt.providerLabel} · {opt.label}
                                </span>
                                <Badge size="sm" variant="outline">
                                  {opt.route === "direct_api" ? (
                                    <T>Direct API</T>
                                  ) : (
                                    <T>CLI subscription</T>
                                  )}
                                </Badge>
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectPopup>
                    </Select>
                    {selectedModel ? (
                      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                        <Badge size="sm" variant="secondary">
                          {selectedModel.route === "direct_api" ? (
                            <T>Direct API (no tools, low latency)</T>
                          ) : (
                            <T>CLI subscription (isolated empty cwd)</T>
                          )}
                        </Badge>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    <T>
                      Configure a direct API text generator or CLI provider in Settings to enable AI
                      reading.
                    </T>
                  </p>
                )}
              </section>

              {/* Ask Document Form */}
              <section className="flex flex-col gap-2">
                {askTargetBlock ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2 py-1 text-2xs">
                    <span className="truncate">
                      <T>
                        Anchored to <Var>{askTargetBlock.label}</Var>
                      </T>
                    </span>
                    <button className="underline" type="button" onClick={onClearAskTarget}>
                      <T>Clear</T>
                    </button>
                  </div>
                ) : null}
                <Textarea
                  aria-label={gt("Ask a question about this document")}
                  data-testid="deepread-ask-input"
                  placeholder={gt("Ask about a proof, experiment, or figure in this document...")}
                  rows={3}
                  value={askDraft}
                  onChange={(event) => onChangeAskDraft(event.target.value)}
                />
                <Button
                  data-testid="deepread-ask-submit"
                  disabled={!canWrite || !askDraft.trim() || aiBusyLabel !== null}
                  size="xs"
                  onClick={onRunAskQuestion}
                >
                  <BotIcon className="size-3.5" />
                  <T>Ask document</T>
                </Button>
              </section>

              {/* Persisted Q&A list with clickable physical page citations */}
              <section className="flex flex-col gap-2">
                <h3 className="font-semibold">
                  <T>
                    Questions (<Var>{questions.length}</Var>)
                  </T>
                </h3>
                {questions.map((q) => {
                  const sources = parseQuestionSources(q.sourcesJson);
                  return (
                    <div key={q.id} className="flex flex-col gap-1.5 rounded-md border p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium">{q.question}</p>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            aria-label={gt("Delete question")}
                            disabled={!canWrite}
                            size="xs"
                            variant="ghost"
                            onClick={() => onDeleteQuestion(q.id)}
                          >
                            <Trash2Icon className="size-3" />
                          </Button>
                        </div>
                      </div>
                      {q.selfAnswer ? (
                        <p className="rounded-sm bg-muted/30 p-1.5 text-2xs text-muted-foreground">
                          <T>
                            My note: <Var>{q.selfAnswer}</Var>
                          </T>
                        </p>
                      ) : null}
                      <p className="whitespace-pre-wrap text-muted-foreground">{q.answer}</p>
                      <div className="flex flex-wrap items-center gap-1">
                        {sources.length > 0 ? (
                          sources.map((src) => (
                            <Button
                              key={`${src.physicalPage}:${src.quote}`}
                              size="xs"
                              variant="outline"
                              onClick={() => onJumpToPage(src.physicalPage)}
                            >
                              <T>
                                Check p.<Var>{src.physicalPage}</Var>
                              </T>
                            </Button>
                          ))
                        ) : (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => onJumpToPage(q.physicalPage)}
                          >
                            <T>
                              Check p.<Var>{q.physicalPage}</Var>
                            </T>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>

              {/* Send to T3 Main Thread (same-env draft, never overwrites existing draft) */}
              <section className="flex flex-col gap-2 rounded-md border p-2.5">
                <h3 className="font-semibold">
                  <T>Continue in T3 main thread</T>
                </h3>
                {projects.length > 0 ? (
                  <>
                    <Select
                      value={selectedProjectId ?? projects[0]!.id}
                      onValueChange={(next) => next && onSelectProjectId(next as ProjectId)}
                    >
                      <SelectTrigger aria-label={gt("Target project")} size="sm">
                        <SelectValue>
                          {projects.find((p) => p.id === selectedProjectId)?.name ??
                            projects[0]!.name}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {projects.map((proj) => (
                          <SelectItem key={proj.id} value={proj.id}>
                            {proj.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    <Textarea
                      aria-label={gt("Question for T3 main thread")}
                      data-testid="deepread-send-thread-input"
                      placeholder={gt("What should the coding agent investigate using this paper?")}
                      rows={2}
                      value={threadQuestion}
                      onChange={(event) => setThreadQuestion(event.target.value)}
                    />
                    <Button
                      data-testid="deepread-send-thread-btn"
                      disabled={!threadQuestion.trim() || sendingToThread}
                      size="xs"
                      variant="secondary"
                      onClick={() => onSendToT3Thread(threadQuestion.trim())}
                    >
                      <SendIcon className="size-3.5" />
                      <T>Send to T3 main thread</T>
                    </Button>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    <T>
                      Add a project in this environment to start a T3 main thread with this paper.
                    </T>
                  </p>
                )}
              </section>
            </div>
          ) : null}

          {/* TAB 5: DeepRead Display Preferences & ima Knowledge Base */}
          {activeTab === "settings" ? (
            <div className="flex flex-col gap-4" data-testid="deepread-panel-settings">
              <section className="flex flex-col gap-2.5 rounded-md border p-2.5">
                <h2 className="font-semibold text-sm">
                  <T>DeepRead layout & cards</T>
                </h2>

                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">
                    <T>
                      Card font size: <Var>{preferences.cardFontSize}</Var>px
                    </T>
                  </span>
                  <input
                    max={18}
                    min={12}
                    type="range"
                    value={preferences.cardFontSize}
                    onChange={(event) =>
                      onUpdatePreference("cardFontSize", String(event.target.value))
                    }
                  />
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">
                    <T>
                      Rail width: <Var>{preferences.railWidth}</Var>px
                    </T>
                  </span>
                  <input
                    max={420}
                    min={200}
                    step={10}
                    type="range"
                    value={preferences.railWidth}
                    onChange={(event) =>
                      onUpdatePreference("railWidth", String(event.target.value))
                    }
                  />
                </label>

                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground">
                    <T>Sentence highlight density</T>
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {HIGHLIGHT_DENSITIES.map((density: HighlightDensity) => (
                      <Button
                        key={density}
                        size="xs"
                        variant={preferences.highlightDensity === density ? "secondary" : "outline"}
                        onClick={() => onUpdatePreference("highlightDensity", density)}
                      >
                        {density}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <Button
                    size="xs"
                    variant={preferences.keepExpanded ? "secondary" : "outline"}
                    onClick={() =>
                      onUpdatePreference(
                        "keepExpanded",
                        preferences.keepExpanded ? "false" : "true",
                      )
                    }
                  >
                    {preferences.keepExpanded ? (
                      <T>Keep expanded: On</T>
                    ) : (
                      <T>Keep expanded: Off</T>
                    )}
                  </Button>
                  {hiddenCardCount > 0 ? (
                    <Button size="xs" variant="outline" onClick={onRestoreHiddenCards}>
                      <T>
                        Restore hidden cards (<Var>{hiddenCardCount}</Var>)
                      </T>
                    </Button>
                  ) : null}
                </div>
              </section>

              {/* ima Knowledge Base Settings (dual settings+providers gated) + Search */}
              <section className="flex flex-col gap-2.5 rounded-md border p-2.5">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-1.5 font-semibold text-sm">
                    <DatabaseIcon className="size-3.5" />
                    <T>ima knowledge base</T>
                  </h2>
                  <Badge size="sm" variant={imaStatus?.hasApiKey ? "secondary" : "outline"}>
                    {imaStatus?.hasApiKey ? <T>Key stored</T> : <T>Not configured</T>}
                  </Badge>
                </div>

                {canManageIma ? (
                  <div className="flex flex-col gap-2" data-testid="deepread-ima-config-form">
                    <label className="flex items-center gap-2">
                      <input
                        checked={imaEnabled}
                        type="checkbox"
                        onChange={(event) => setImaEnabled(event.target.checked)}
                      />
                      <span>
                        <T>Enable ima integration</T>
                      </span>
                    </label>
                    <Input
                      aria-label={gt("ima HTTPS base URL")}
                      placeholder={gt("https://ima.example.com/api")}
                      value={imaBaseUrl}
                      onChange={(event) => setImaBaseUrl(event.target.value)}
                    />
                    <Input
                      aria-label={gt("ima knowledge base ID")}
                      placeholder={gt("Knowledge base ID")}
                      value={imaKbId}
                      onChange={(event) => setImaKbId(event.target.value)}
                    />
                    <Input
                      aria-label={gt("ima API key")}
                      placeholder={
                        imaStatus?.hasApiKey
                          ? gt("API key stored on server (enter new value to rotate)")
                          : gt("Enter ima API key (stored in server secret store)")
                      }
                      type="password"
                      value={imaApiKey}
                      onChange={(event) => setImaApiKey(event.target.value)}
                    />
                    <Button
                      data-testid="deepread-ima-save-btn"
                      disabled={imaSaving}
                      size="xs"
                      onClick={() => {
                        void handleSaveIma();
                      }}
                    >
                      <T>Save ima settings</T>
                    </Button>
                  </div>
                ) : (
                  <Alert variant="warning">
                    <LockIcon />
                    <AlertDescription>
                      <T>
                        Updating ima settings requires both settings and provider management
                        permissions.
                      </T>
                    </AlertDescription>
                  </Alert>
                )}

                {imaStatus?.enabled && imaStatus.hasApiKey ? (
                  <div className="flex flex-col gap-2 border-t pt-2">
                    <div className="flex items-center gap-1.5">
                      <Input
                        aria-label={gt("Search ima knowledge base")}
                        placeholder={gt("Search ima knowledge base...")}
                        value={imaQuery}
                        onChange={(event) => setImaQuery(event.target.value)}
                      />
                      <Button
                        disabled={!imaQuery.trim() || imaSearching}
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          void handleRunImaSearch();
                        }}
                      >
                        <SearchIcon className="size-3.5" />
                        <T>Search</T>
                      </Button>
                    </div>
                    {imaHits.map((hit) => (
                      <div key={hit.id} className="rounded-md border p-2">
                        <div className="font-medium">{hit.title}</div>
                        <p className="mt-0.5 line-clamp-3 text-muted-foreground">{hit.snippet}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

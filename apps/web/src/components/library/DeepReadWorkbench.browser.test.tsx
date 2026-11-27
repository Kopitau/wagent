import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  type LibraryEntry,
  type LibraryImaConfigView,
  type LibraryReadingInsightContract,
  type LibraryReadingModelOption,
  type LibraryReadingParagraphContract,
  type LibraryReadingQuestionContract,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { parseDeepReadGuideImport } from "@t3tools/research-library/reader";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { Atom } from "effect/reactivity";
import * as ReactHooks from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

const ENV_A = EnvironmentId.make("env-deepread");
const PROJECT_A = ProjectId.make("proj-deepread");

const mockState = vi.hoisted(() => {
  let canWrite = true;
  let canManageIma = true;
  let physicalPage = 1;
  let paragraphs: LibraryReadingParagraphContract[] = [];
  let questions: LibraryReadingQuestionContract[] = [];
  let insights: LibraryReadingInsightContract[] = [];
  let preferences: Record<string, string> = {};
  let imaStatus: LibraryImaConfigView = {
    enabled: false,
    baseUrl: "",
    knowledgeBaseId: "",
    hasApiKey: false,
  };
  let models: LibraryReadingModelOption[] = [
    {
      instanceId: "tg-openai",
      model: "gpt-4o-mini",
      label: "GPT-4o Mini",
      providerLabel: "OpenAI Direct",
      route: "direct_api",
    },
    {
      instanceId: "claude-sub",
      model: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      providerLabel: "Claude CLI",
      route: "cli_subscription",
    },
  ];
  const syncWkbCalls: Array<{ readonly entryId: string; readonly sourceId: string }> = [];
  const aiCalls: Array<{ readonly action: string; aborted: boolean }> = [];
  const newThreadCalls: Array<{
    readonly projectRef: ScopedProjectRef;
    readonly prompt: string | undefined;
  }> = [];
  let holdAiUntilAbort = false;

  return {
    get canWrite() {
      return canWrite;
    },
    set canWrite(v: boolean) {
      canWrite = v;
    },
    get canManageIma() {
      return canManageIma;
    },
    set canManageIma(v: boolean) {
      canManageIma = v;
    },
    get physicalPage() {
      return physicalPage;
    },
    set physicalPage(v: number) {
      physicalPage = v;
    },
    get paragraphs() {
      return paragraphs;
    },
    set paragraphs(v: LibraryReadingParagraphContract[]) {
      paragraphs = v;
    },
    get questions() {
      return questions;
    },
    set questions(v: LibraryReadingQuestionContract[]) {
      questions = v;
    },
    get insights() {
      return insights;
    },
    set insights(v: LibraryReadingInsightContract[]) {
      insights = v;
    },
    get preferences() {
      return preferences;
    },
    set preferences(v: Record<string, string>) {
      preferences = v;
    },
    get imaStatus() {
      return imaStatus;
    },
    set imaStatus(v: LibraryImaConfigView) {
      imaStatus = v;
    },
    get models() {
      return models;
    },
    set models(v: LibraryReadingModelOption[]) {
      models = v;
    },
    get holdAiUntilAbort() {
      return holdAiUntilAbort;
    },
    set holdAiUntilAbort(v: boolean) {
      holdAiUntilAbort = v;
    },
    syncWkbCalls,
    aiCalls,
    newThreadCalls,
    reset() {
      canWrite = true;
      canManageIma = true;
      physicalPage = 1;
      paragraphs = [];
      questions = [];
      insights = [];
      preferences = {};
      imaStatus = { enabled: false, baseUrl: "", knowledgeBaseId: "", hasApiKey: false };
      syncWkbCalls.length = 0;
      aiCalls.length = 0;
      newThreadCalls.length = 0;
      holdAiUntilAbort = false;
    },
  };
});

vi.mock(import("@tanstack/react-router"), (async (
  original: () => Promise<Record<string, unknown>>,
) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
})) as never);

vi.mock(import("../../state/entities"), (() => ({
  useProjects: () => [{ id: PROJECT_A, environmentId: ENV_A, title: "Quantum Repo" }],
})) as never);

vi.mock(import("../../hooks/useHandleNewThread"), (() => ({
  useNewThreadHandler:
    () => async (projectRef: ScopedProjectRef, options?: { prompt?: string }) => {
      mockState.newThreadCalls.push({ projectRef, prompt: options?.prompt });
      return null;
    },
})) as never);

vi.mock(import("../../state/library"), (() => {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const fn of listeners) fn();
  };
  const permAtoms = new Map<string, Atom.Atom<boolean>>();
  const getPerm = (key: string, value: boolean) => {
    const cacheKey = `${key}:${value}`;
    let atom = permAtoms.get(cacheKey);
    if (!atom) {
      atom = Atom.make(value);
      permAtoms.set(cacheKey, atom);
    }
    return atom;
  };
  const makeCmd = (op: string) => ({
    label: `mock-deepread:${op}`,
    op,
    permissionAtom: () =>
      op === "updateImaConfig"
        ? getPerm("ima", mockState.canManageIma)
        : getPerm("write", mockState.canWrite),
  });

  const useTick = () => {
    const [, setTick] = ReactHooks.useState(0);
    ReactHooks.useEffect(() => {
      const fn = () => setTick((t) => t + 1);
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    }, []);
  };

  return {
    __notifyDeepRead: notify,
    libraryEnvironment: {
      loadPdfBytes: makeCmd("loadPdfBytes"),
      setReadingPosition: makeCmd("setReadingPosition"),
      upsertReadingParagraph: makeCmd("upsertReadingParagraph"),
      upsertReadingQuestion: makeCmd("upsertReadingQuestion"),
      deleteReadingQuestion: makeCmd("deleteReadingQuestion"),
      setReadingPreference: makeCmd("setReadingPreference"),
      runReadingAiAction: makeCmd("runReadingAiAction"),
      importGuide: makeCmd("importGuide"),
      syncWkbAnnotations: makeCmd("syncWkbAnnotations"),
      submitToWkb: makeCmd("submitToWkb"),
      updateImaConfig: makeCmd("updateImaConfig"),
      imaSearch: makeCmd("imaSearch"),
      composeDraft: makeCmd("composeDraft"),
    },
    useLibraryReadingState: (_envId: EnvironmentId | null, entryId: string | null) => {
      useTick();
      return {
        data:
          entryId === null
            ? null
            : {
                entryId,
                physicalPage: mockState.physicalPage,
                paragraphs: [...mockState.paragraphs],
                questions: [...mockState.questions],
                insights: [...mockState.insights],
                preferences: { ...mockState.preferences },
                pages: [
                  {
                    physicalPage: 1,
                    text: [
                      "1. Introduction",
                      "Surface codes protect quantum information against local errors as shown in Fig. 1 [1].",
                      "Fig. 1. Logical error rate versus physical error rate across code distances.",
                      "Existing decoders incur quadratic overhead when scaling to large lattices.",
                      "We propose a linear-time neural-assisted surface code decoder.",
                    ].join("\n\n"),
                    extractionStatus: "ok" as const,
                  },
                  {
                    physicalPage: 2,
                    text: [
                      "2. Results",
                      "Our decoder achieves 1.05% threshold with 3x lower latency.",
                      "References",
                      "[1] Fowler et al. Surface codes: Towards practical large-scale quantum computation. 2012. doi:10.1103/PhysRevA.86.032324",
                    ].join("\n\n"),
                    extractionStatus: "ok" as const,
                  },
                ],
              },
        dataUpdatedAt: 1,
        error: null,
        failure: null,
        isPending: false,
        isSuccess: true,
        refresh: notify,
      };
    },
    useLibraryReadingModels: () => {
      useTick();
      return {
        data: { models: [...mockState.models] },
        dataUpdatedAt: 1,
        error: null,
        failure: null,
        isPending: false,
        isSuccess: true,
        refresh: notify,
      };
    },
    useLibraryWkbStatus: () => ({
      data: { available: true, mode: "local" as const, detail: "mock" },
      dataUpdatedAt: 1,
      error: null,
      failure: null,
      isPending: false,
      isSuccess: true,
      refresh: notify,
    }),
    useLibraryImaStatus: () => {
      useTick();
      return {
        data: mockState.imaStatus,
        dataUpdatedAt: 1,
        error: null,
        failure: null,
        isPending: false,
        isSuccess: true,
        refresh: notify,
      };
    },
    useLibraryList: () => ({
      data: {
        items: [
          {
            id: "ref-fowler-2012",
            kind: "pdf" as const,
            title: "Surface codes: Towards practical large-scale quantum computation",
            url: null,
            tags: ["quantum"],
            snippet: "",
            notePreview: "",
            matchedPages: [],
            pageCount: 10,
            revision: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        total: 1,
        hasMore: false,
        searchMode: "fts" as const,
      },
      dataUpdatedAt: 1,
      error: null,
      failure: null,
      isPending: false,
      isSuccess: true,
      refresh: notify,
    }),
  };
}) as never);

vi.mock(import("../../state/use-atom-command"), (async () => {
  const libMod = (await import("../../state/library")) as unknown as {
    __notifyDeepRead: () => void;
  };
  return {
    useAtomCommand:
      (command: { readonly op: string }) =>
      async (
        args: { readonly environmentId: EnvironmentId; readonly input: Record<string, unknown> },
        call?: { readonly signal?: AbortSignal | undefined },
      ) => {
        const input = args.input;
        switch (command.op) {
          case "setReadingPosition":
            mockState.physicalPage = Number(input.physicalPage ?? 1);
            libMod.__notifyDeepRead();
            return Exit.succeed({
              entryId: String(input.entryId),
              physicalPage: mockState.physicalPage,
            });
          case "setReadingPreference":
            mockState.preferences = {
              ...mockState.preferences,
              [String(input.scopeKey)]: String(input.valueJson),
            };
            libMod.__notifyDeepRead();
            return Exit.succeed({ ok: true });
          case "upsertReadingParagraph": {
            const anchor = String(input.anchor);
            const existing = mockState.paragraphs.find((p) => p.anchor === anchor);
            const next: LibraryReadingParagraphContract = {
              entryId: String(input.entryId),
              physicalPage: Number(input.physicalPage ?? 1),
              anchor,
              blobSha256: null,
              anchorAlgoVersion: 1,
              quote: String(input.quote ?? existing?.quote ?? ""),
              note: input.note !== undefined ? String(input.note) : (existing?.note ?? ""),
              marked:
                input.marked !== undefined ? Boolean(input.marked) : (existing?.marked ?? false),
              highlighted:
                input.highlighted !== undefined
                  ? Boolean(input.highlighted)
                  : (existing?.highlighted ?? false),
              highlightColor: "",
              hidden: false,
              mergedInto: null,
              wkbKind:
                input.wkbKind !== undefined ? String(input.wkbKind) : (existing?.wkbKind ?? "重点"),
              analysisJson: existing?.analysisJson ?? null,
              updatedAt: "2026-11-24T00:00:00.000Z",
            };
            mockState.paragraphs = [
              ...mockState.paragraphs.filter((p) => p.anchor !== anchor),
              next,
            ];
            libMod.__notifyDeepRead();
            return Exit.succeed(next);
          }
          case "importGuide": {
            const parsed = parseDeepReadGuideImport(String(input.content ?? ""));
            const insight: LibraryReadingInsightContract = {
              entryId: String(input.entryId),
              kind: "guide",
              payloadJson: JSON.stringify(parsed),
              modelId: "imported",
              updatedAt: "2026-11-24T00:00:00.000Z",
            };
            mockState.insights = [...mockState.insights.filter((i) => i.kind !== "guide"), insight];
            libMod.__notifyDeepRead();
            return Exit.succeed(insight);
          }
          case "syncWkbAnnotations":
            mockState.syncWkbCalls.push({
              entryId: String(input.entryId),
              sourceId: String(input.sourceId),
            });
            return Exit.succeed({
              mode: "local" as const,
              syncedCount: mockState.paragraphs.filter((p) => p.note.trim() || p.marked).length,
              summary: "synced",
            });
          case "submitToWkb":
            return Exit.succeed({ mode: "local" as const, summary: "submitted" });
          case "updateImaConfig":
            mockState.imaStatus = {
              enabled: Boolean(input.enabled ?? mockState.imaStatus.enabled),
              baseUrl: String(input.baseUrl ?? mockState.imaStatus.baseUrl),
              knowledgeBaseId: String(input.knowledgeBaseId ?? mockState.imaStatus.knowledgeBaseId),
              hasApiKey: Boolean(input.apiKey) || mockState.imaStatus.hasApiKey,
            };
            libMod.__notifyDeepRead();
            return Exit.succeed(mockState.imaStatus);
          case "composeDraft":
            return Exit.succeed({
              prompt: `DRAFT(${String(input.question)})`,
              entryIds: [String((input.entryIds as string[])[0])],
              environmentId: args.environmentId,
            });
          case "runReadingAiAction": {
            const rec = { action: String(input.action), aborted: false };
            mockState.aiCalls.push(rec);
            if (mockState.holdAiUntilAbort) {
              await new Promise<void>((resolve) => {
                if (call?.signal?.aborted) {
                  rec.aborted = true;
                  resolve();
                  return;
                }
                call?.signal?.addEventListener(
                  "abort",
                  () => {
                    rec.aborted = true;
                    resolve();
                  },
                  { once: true },
                );
              });
              // Cancelled before completion -> persist NOTHING!
              return Exit.fail(Cause.interrupt());
            }
            return Exit.succeed({
              action: input.action,
              route: "direct_api",
              modelId: "tg-openai/gpt-4o-mini",
              payloadJson: "{}",
            });
          }
          default:
            return Exit.succeed({});
        }
      },
  };
}) as never);

const sampleEntry: LibraryEntry = {
  id: "paper-surface-code",
  kind: "pdf",
  title: "Linear-Time Surface Code Decoding",
  url: null,
  body: "Surface codes overview.",
  note: "",
  tags: ["quantum"],
  blobSha256: null,
  blobBytes: null,
  blobMissing: false,
  pageCount: 2,
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  revision: 1,
};

const { DeepReadWorkbench } = await import("./DeepReadWorkbench");

it("renders dual-column non-overlapping rails, explicit click-expand, muddiest wkb sync, guide jump, hover lookup, AI cancel without persistence, and ima scope gating", async () => {
  mockState.reset();
  mockState.canManageIma = false;

  const rendered = await render(
    <RegistryProvider>
      <div className="flex h-dvh w-screen flex-col">
        <DeepReadWorkbench environmentId={ENV_A} entry={sampleEntry} />
      </div>
    </RegistryProvider>,
  );

  // 1. Both left & right rails render and cards start compact (hover NEVER expands them)
  const leftRail = page.getByTestId("deepread-rail-left");
  const rightRail = page.getByTestId("deepread-rail-right");
  await expect.element(leftRail).toBeVisible();
  await expect.element(rightRail).toBeVisible();

  const cardP1Para2 = page.getByTestId("deepread-card-p_0_1");
  await expect.element(cardP1Para2).toBeVisible();
  await expect.element(cardP1Para2).toHaveAttribute("data-expanded", "false");

  // Hovering a compact card must NOT open it
  await userEvent.hover(cardP1Para2);
  await expect.element(cardP1Para2).toHaveAttribute("data-expanded", "false");

  // Explicit click expands the card
  await userEvent.click(page.getByTestId("deepread-card-toggle-p_0_1"));
  await expect.element(cardP1Para2).toHaveAttribute("data-expanded", "true");

  // Verify cards in each rail do not vertically overlap
  for (const side of ["left", "right"] as const) {
    const cards = Array.from(
      document.querySelectorAll(`[data-testid="deepread-rail-${side}"] [data-deepread="card"]`),
    ).map((el) => el.getBoundingClientRect());
    cards.sort((a, b) => a.top - b.top);
    for (let i = 1; i < cards.length; i += 1) {
      expect(cards[i]!.top).toBeGreaterThanOrEqual(cards[i - 1]!.bottom - 1);
    }
  }

  // 2. Hover Lookup Popover resolves Fig. 1 with ZERO AI calls, and Esc dismisses it
  const textBlock = page.getByTestId("deepread-text-block-p_0_1");
  await userEvent.hover(textBlock);
  await expect.element(page.getByTestId("deepread-hover-lookup-popover")).toBeVisible();
  expect(mockState.aiCalls).toHaveLength(0);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByTestId("deepread-hover-lookup-popover")).not.toBeInTheDocument();

  // 3. Mark paragraph as muddiest point, then sync annotations to wkb brain
  const muddiestBtn = cardP1Para2.getByRole("button", { name: "Mark as muddiest point" });
  await userEvent.click(muddiestBtn);
  expect(mockState.paragraphs.some((p) => p.marked && p.wkbKind === "存疑")).toBe(true);

  await userEvent.click(page.getByTestId("deepread-tab-notes"));
  await userEvent.click(page.getByTestId("deepread-sync-wkb-btn"));
  expect(mockState.syncWkbCalls).toHaveLength(1);
  expect(mockState.syncWkbCalls[0]?.entryId).toBe("paper-surface-code");

  // 4. Import 5-stage DeepRead Guide and click p_1_0 to jump physical page 1 -> 2
  await userEvent.click(page.getByTestId("deepread-tab-guide"));
  await userEvent.click(page.getByRole("button", { name: "Import" }));
  const guideJson = JSON.stringify({
    position: {
      claim: "Linear-time surface code decoding matches optimal threshold.",
      path: [{ step: "Evidence", text: "1.05% threshold on page 2", keys: ["p_1_0"] }],
    },
    skeleton: { moves: [{ role: "result", text: "Threshold improvement", keys: ["p_1_0"] }] },
    method: { insight: { core: "Neural-assisted matching" } },
    evidence: { chain: [{ claim: "1.05% threshold", evidence: "Table results", keys: ["p_1_0"] }] },
    takeaway: { summary: "Practical real-time decoding." },
  });
  await userEvent.fill(page.getByTestId("deepread-guide-import-input"), guideJson);
  await userEvent.click(page.getByTestId("deepread-guide-import-submit"));
  await expect
    .element(page.getByText("Linear-time surface code decoding matches optimal threshold."))
    .toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "p_1_0" }).first());
  await expect.element(page.getByTestId("deepread-page-indicator")).toHaveTextContent("p.2 / 2");

  // 5. Ask tab: direct_api badge shown, cancelling in-flight AI action aborts without persisting anything
  await userEvent.click(page.getByTestId("deepread-tab-ask"));
  await expect.element(page.getByText("Direct API (no tools, low latency)")).toBeVisible();

  mockState.holdAiUntilAbort = true;
  await userEvent.fill(page.getByTestId("deepread-ask-input"), "What is the threshold?");
  await userEvent.click(page.getByTestId("deepread-ask-submit"));
  await expect.element(page.getByTestId("deepread-ai-cancel-btn")).toBeVisible();
  await userEvent.click(page.getByTestId("deepread-ai-cancel-btn"));
  expect(mockState.aiCalls.at(-1)?.aborted).toBe(true);
  expect(mockState.questions).toHaveLength(0);

  // 6. Send to T3 main thread passes environment + project + composed draft prompt
  await userEvent.fill(
    page.getByTestId("deepread-send-thread-input"),
    "Implement the linear-time decoder benchmark.",
  );
  await userEvent.click(page.getByTestId("deepread-send-thread-btn"));
  expect(mockState.newThreadCalls).toHaveLength(1);
  expect(mockState.newThreadCalls[0]?.projectRef).toEqual({
    environmentId: ENV_A,
    projectId: PROJECT_A,
  });
  expect(mockState.newThreadCalls[0]?.prompt).toContain(
    "Implement the linear-time decoder benchmark.",
  );

  // 7. Settings tab enforces dual settings+providers scope on ima config
  await userEvent.click(page.getByTestId("deepread-tab-settings"));
  await expect.element(page.getByTestId("deepread-ima-config-form")).not.toBeInTheDocument();
  await expect
    .element(
      page.getByText(
        "Updating ima settings requires both settings and provider management permissions.",
      ),
    )
    .toBeVisible();

  await rendered.unmount();
});

import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  LibraryEditConflictError,
  LibraryNotFoundError,
  LibraryStorageError,
  ProjectId,
  type LibraryComposeDraftInput,
  type LibraryDeleteInput,
  type LibraryEntry,
  type LibraryFetchUrlInput,
  type LibraryImportFromWkbInput,
  type LibraryImportTextFileInput,
  type LibraryListInput,
  type LibrarySaveInput,
  type LibraryUpdateInput,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { composeLibraryDraft, validateTextImportFile } from "@t3tools/research-library";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SidebarProvider } from "~/components/ui/sidebar";
import "~/index.css";

import { render } from "../../../test/render";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const ENV_LEGACY = EnvironmentId.make("env-legacy");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

interface FakeEnvState {
  readonly entries: Map<string, LibraryEntry>;
  readonly existingDraftTextByProject: Map<string, string>;
}

const mockStore = vi.hoisted(() => {
  const environments: Array<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly supportsLibrary: boolean;
    readonly canRead: boolean;
    readonly canWrite: boolean;
  }> = [];
  const byEnv = new Map<EnvironmentId, FakeEnvState>();
  const listCalls: Array<{
    readonly environmentId: EnvironmentId;
    readonly input: LibraryListInput;
  }> = [];
  const newThreadCalls: Array<{
    readonly projectRef: ScopedProjectRef;
    readonly prompt: string | undefined;
    readonly preservedExistingDraft: boolean;
  }> = [];
  let nextId = 1;
  let listVersion = 0;

  return {
    environments,
    byEnv,
    listCalls,
    newThreadCalls,
    nextId: () => `entry-${nextId++}`,
    bumpVersion: () => {
      listVersion += 1;
      return listVersion;
    },
    getVersion: () => listVersion,
    reset: () => {
      environments.length = 0;
      byEnv.clear();
      listCalls.length = 0;
      newThreadCalls.length = 0;
      nextId = 1;
      listVersion = 0;
    },
  };
});

vi.mock(import("../../state/environments"), (async (
  original: () => Promise<Record<string, unknown>>,
) => ({
  ...(await original()),
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: mockStore.environments.map((env) => ({
      environmentId: env.environmentId,
      label: env.label,
      displayUrl: null,
      relayManaged: false,
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          capabilities: env.supportsLibrary ? { researchLibrary: true } : {},
        },
      },
    })),
    presentationById: new Map(),
  }),
  useResearchLibrarySupported: () => mockStore.environments.some((env) => env.supportsLibrary),
})) as never);

vi.mock(import("../../state/entities"), (() => ({
  useProjects: () => [
    { id: PROJECT_A, environmentId: ENV_A, title: "Alpha Repo" },
    { id: PROJECT_B, environmentId: ENV_B, title: "Beta Repo" },
  ],
})) as never);

vi.mock(import("../../hooks/useHandleNewThread"), (() => ({
  useNewThreadHandler:
    () => async (projectRef: ScopedProjectRef, options?: { prompt?: string }) => {
      const envState = mockStore.byEnv.get(projectRef.environmentId);
      const existing = envState?.existingDraftTextByProject.get(projectRef.projectId) ?? "";
      const preservedExistingDraft = existing.trim().length > 0;
      if (!preservedExistingDraft && envState && options?.prompt !== undefined) {
        envState.existingDraftTextByProject.set(projectRef.projectId, options.prompt);
      }
      mockStore.newThreadCalls.push({
        projectRef,
        prompt: options?.prompt,
        preservedExistingDraft,
      });
      return null;
    },
})) as never);

vi.mock(import("../../state/library"), (() => {
  const versionListeners = new Set<() => void>();
  const notify = () => {
    mockStore.bumpVersion();
    for (const listener of versionListeners) listener();
  };

  const permissionAtoms = new Map<string, Atom.Atom<boolean>>();
  const getPermAtom = (kind: "read" | "write", environmentId: EnvironmentId | null) => {
    const env = mockStore.environments.find((item) => item.environmentId === environmentId);
    const allowed = env ? (kind === "read" ? env.canRead : env.canWrite) : false;
    const key = `${kind}:${environmentId ?? "none"}:${allowed}`;
    let atom = permissionAtoms.get(key);
    if (!atom) {
      atom = Atom.make(allowed);
      permissionAtoms.set(key, atom);
    }
    return atom;
  };

  const makeCommand = (op: string) => ({
    label: `mock-library:${op}`,
    op,
    permissionAtom: (environmentId: EnvironmentId | null) =>
      getPermAtom(op === "composeDraft" ? "read" : "write", environmentId),
  });

  return {
    __notifyMockLibrary: notify,
    libraryEnvironment: {
      save: makeCommand("save"),
      fetchUrl: makeCommand("fetchUrl"),
      importTextFile: makeCommand("importTextFile"),
      importFromWkb: makeCommand("importFromWkb"),
      uploadPdf: makeCommand("uploadPdf"),
      loadPdfBytes: makeCommand("loadPdfBytes"),
      update: makeCommand("update"),
      delete: makeCommand("delete"),
      composeDraft: makeCommand("composeDraft"),
    },
    useLibraryWkbStatus: (environmentId: EnvironmentId | null, enabled: boolean) => ({
      data:
        enabled && environmentId === ENV_A
          ? {
              available: true,
              mode: "dual" as const,
              remoteUrl: "https://kb.example.invalid/kb/mcp",
            }
          : { available: false, mode: "unavailable" as const, remoteUrl: null },
      dataUpdatedAt: 1,
      error: null,
      failure: null,
      isPending: false,
      isSuccess: enabled && environmentId !== null,
      refresh: notify,
    }),
    useLibraryList: (
      environmentId: EnvironmentId | null,
      input: LibraryListInput,
      enabled: boolean,
    ) => {
      const [, setTick] = ReactHooks.useState(0);
      ReactHooks.useEffect(() => {
        const listener = () => setTick((t) => t + 1);
        versionListeners.add(listener);
        return () => {
          versionListeners.delete(listener);
        };
      }, []);

      if (!enabled || environmentId === null) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: false,
          isSuccess: false,
          refresh: notify,
        };
      }

      mockStore.listCalls.push({ environmentId, input });
      const envState = mockStore.byEnv.get(environmentId);
      const all = Array.from(envState?.entries.values() ?? []);
      const query = input.query?.trim().toLowerCase() ?? "";
      const filtered = all.filter((entry) => {
        if (input.kind && entry.kind !== input.kind) return false;
        if (input.tag && !entry.tags.some((t) => t.toLowerCase() === input.tag!.toLowerCase())) {
          return false;
        }
        if (query.length > 0) {
          return (
            entry.title.toLowerCase().includes(query) ||
            entry.body.toLowerCase().includes(query) ||
            entry.note.toLowerCase().includes(query)
          );
        }
        return true;
      });
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 20;
      const slice = filtered.slice(offset, offset + limit);
      return {
        data: {
          items: slice.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            title: entry.title,
            url: entry.url,
            tags: entry.tags,
            snippet: entry.body.slice(0, 120),
            notePreview: entry.note.slice(0, 120),
            matchedPages: [],
            pageCount: entry.pageCount,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            revision: entry.revision,
          })),
          total: filtered.length,
          hasMore: offset + slice.length < filtered.length,
          searchMode: query.length === 0 ? "browse" : query.length < 3 ? "substring" : "fts5",
        },
        dataUpdatedAt: mockStore.getVersion(),
        error: null,
        failure: null,
        isPending: false,
        isSuccess: true,
        refresh: notify,
      };
    },
    useLibraryEntry: (
      environmentId: EnvironmentId | null,
      entryId: string | null,
      enabled: boolean,
    ) => {
      const [, setTick] = ReactHooks.useState(0);
      ReactHooks.useEffect(() => {
        const listener = () => setTick((t) => t + 1);
        versionListeners.add(listener);
        return () => {
          versionListeners.delete(listener);
        };
      }, []);

      if (!enabled || environmentId === null || entryId === null) {
        return {
          data: null,
          dataUpdatedAt: 0,
          error: null,
          failure: null,
          isPending: false,
          isSuccess: false,
          refresh: notify,
        };
      }
      const entry = mockStore.byEnv.get(environmentId)?.entries.get(entryId) ?? null;
      return {
        data: entry ? { entry } : null,
        dataUpdatedAt: mockStore.getVersion(),
        error: entry ? null : "Entry not found",
        failure: entry ? null : new LibraryNotFoundError({ entryId }),
        isPending: false,
        isSuccess: entry !== null,
        refresh: notify,
      };
    },
  };
}) as never);

import * as ReactHooks from "react";

vi.mock(import("../../state/use-atom-command"), (() => ({
  useAtomCommand: (command: { readonly op?: string }) => {
    return async (target: { readonly environmentId: EnvironmentId; readonly input: unknown }) => {
      const { __notifyMockLibrary } = (await import("../../state/library")) as unknown as {
        readonly __notifyMockLibrary: () => void;
      };
      const envState = mockStore.byEnv.get(target.environmentId);
      if (!envState) {
        return Exit.failCause(Cause.fail(new LibraryStorageError({ operation: "unknown_env" })));
      }
      const now = "2026-11-24T08:00:00.000Z";
      switch (command.op) {
        case "save": {
          const input = target.input as LibrarySaveInput;
          const entry: LibraryEntry = {
            id: mockStore.nextId(),
            kind: input.kind,
            title: input.title,
            url: input.url ?? null,
            body: input.body ?? "",
            note: input.note ?? "",
            tags: input.tags ?? [],
            blobSha256: null,
            blobBytes: null,
            blobMissing: false,
            pageCount: 0,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          envState.entries.set(entry.id, entry);
          __notifyMockLibrary();
          return Exit.succeed(entry);
        }
        case "fetchUrl": {
          const input = target.input as LibraryFetchUrlInput;
          const entry: LibraryEntry = {
            id: mockStore.nextId(),
            kind: input.url.includes("mp.weixin.qq.com") ? "wechat" : "web",
            title: input.title ?? "Fetched Web Article",
            url: input.url,
            body: "",
            note: input.note ?? "",
            tags: input.tags ?? [],
            blobSha256: null,
            blobBytes: null,
            blobMissing: false,
            pageCount: 0,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          envState.entries.set(entry.id, entry);
          __notifyMockLibrary();
          return Exit.succeed({
            entry,
            fetched: false,
            fallbackReason: "WeChat requires verification; saved link only.",
          });
        }
        case "importFromWkb": {
          const input = target.input as LibraryImportFromWkbInput;
          const entry: LibraryEntry = {
            id: mockStore.nextId(),
            kind: "video",
            title: "Bilibili Keynote Talk",
            url: input.source,
            body: "[00:00:01] Multimodal transcript extracted by wkb.",
            note: input.note ?? "",
            tags: input.tags ?? [],
            blobSha256: null,
            blobBytes: null,
            blobMissing: false,
            pageCount: 0,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          envState.entries.set(entry.id, entry);
          __notifyMockLibrary();
          return Exit.succeed({ entry, warnings: [] });
        }
        case "uploadPdf": {
          const input = target.input as { readonly fileName: string; readonly bytes: Uint8Array };
          const entry: LibraryEntry = {
            id: mockStore.nextId(),
            kind: "pdf",
            title: input.fileName.replace(/\.pdf$/iu, ""),
            url: null,
            body: "[p.1]\nUploaded PDF extracted text",
            note: "",
            tags: [],
            blobSha256: "a".repeat(64),
            blobBytes: input.bytes.byteLength,
            blobMissing: true,
            pageCount: 1,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          envState.entries.set(entry.id, entry);
          __notifyMockLibrary();
          return Exit.succeed(entry);
        }
        case "loadPdfBytes": {
          return Exit.succeed(new ArrayBuffer(0));
        }
        case "importTextFile": {
          const input = target.input as LibraryImportTextFileInput;
          const validated = validateTextImportFile({
            fileName: input.fileName,
            content: input.content,
            title: input.title,
          });
          const entry: LibraryEntry = {
            id: mockStore.nextId(),
            kind: "file",
            title: validated.title,
            url: null,
            body: validated.body,
            note: input.note ?? "",
            tags: input.tags ?? [],
            blobSha256: null,
            blobBytes: null,
            blobMissing: false,
            pageCount: 0,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          envState.entries.set(entry.id, entry);
          __notifyMockLibrary();
          return Exit.succeed(entry);
        }
        case "update": {
          const input = target.input as LibraryUpdateInput;
          const current = envState.entries.get(input.id);
          if (!current) {
            return Exit.failCause(Cause.fail(new LibraryNotFoundError({ entryId: input.id })));
          }
          if (current.revision !== input.expectedRevision) {
            return Exit.failCause(
              Cause.fail(
                new LibraryEditConflictError({
                  entryId: input.id,
                  expectedRevision: input.expectedRevision,
                  currentRevision: current.revision,
                }),
              ),
            );
          }
          const updated: LibraryEntry = {
            ...current,
            title: input.title ?? current.title,
            url: input.url !== undefined ? input.url : current.url,
            body: input.body ?? current.body,
            note: input.note ?? current.note,
            tags: input.tags ?? current.tags,
            updatedAt: now,
            revision: current.revision + 1,
          };
          envState.entries.set(updated.id, updated);
          __notifyMockLibrary();
          return Exit.succeed(updated);
        }
        case "delete": {
          const input = target.input as LibraryDeleteInput;
          const current = envState.entries.get(input.id);
          if (!current) {
            return Exit.failCause(Cause.fail(new LibraryNotFoundError({ entryId: input.id })));
          }
          if (current.revision !== input.expectedRevision) {
            return Exit.failCause(
              Cause.fail(
                new LibraryEditConflictError({
                  entryId: input.id,
                  expectedRevision: input.expectedRevision,
                  currentRevision: current.revision,
                }),
              ),
            );
          }
          envState.entries.delete(input.id);
          __notifyMockLibrary();
          return Exit.succeed({ id: input.id, deletedRevision: input.expectedRevision });
        }
        case "composeDraft": {
          const input = target.input as LibraryComposeDraftInput;
          const entries = input.entryIds.map((id) => {
            const found = envState.entries.get(id);
            if (!found) throw new Error(`Missing ${id}`);
            return found;
          });
          const composed = composeLibraryDraft({
            environmentId: target.environmentId,
            entries,
            question: input.question,
          });
          return Exit.succeed(composed);
        }
        default:
          return Exit.failCause(Cause.fail(new LibraryStorageError({ operation: "unsupported" })));
      }
    };
  },
})) as never);

import { LibraryPage } from "./LibraryPage";

function setupMultiEnvironmentFixture() {
  mockStore.reset();
  mockStore.environments.push(
    {
      environmentId: ENV_A,
      label: "Env A",
      supportsLibrary: true,
      canRead: true,
      canWrite: true,
    },
    {
      environmentId: ENV_B,
      label: "Env B",
      supportsLibrary: true,
      canRead: true,
      canWrite: true,
    },
    {
      environmentId: ENV_LEGACY,
      label: "Legacy Env",
      supportsLibrary: false,
      canRead: true,
      canWrite: true,
    },
  );
  mockStore.byEnv.set(ENV_A, {
    entries: new Map(),
    existingDraftTextByProject: new Map(),
  });
  mockStore.byEnv.set(ENV_B, {
    entries: new Map([
      [
        "env-b-1",
        {
          id: "env-b-1",
          kind: "note",
          title: "Env B Isolated Entry",
          url: null,
          body: "Only in environment B",
          note: "",
          tags: ["isolated"],
          blobSha256: null,
          blobBytes: null,
          blobMissing: false,
          pageCount: 0,
          createdAt: "2026-11-24T08:00:00.000Z",
          updatedAt: "2026-11-24T08:00:00.000Z",
          revision: 1,
        },
      ],
    ]),
    existingDraftTextByProject: new Map(),
  });
  mockStore.byEnv.set(ENV_LEGACY, {
    entries: new Map(),
    existingDraftTextByProject: new Map(),
  });
}

it("runs the M1a vertical slice: collect, import MD, conflict handling, same-env draft without overwrite, and cross-env/legacy isolation", async () => {
  setupMultiEnvironmentFixture();

  await using screen = await render(
    <RegistryProvider>
      <SidebarProvider>
        <LibraryPage requestedEnvironmentId={ENV_A} />
      </SidebarProvider>
    </RegistryProvider>,
    { router: "/library" },
  );

  // 1. Create a standalone note in Environment A.
  await userEvent.click(screen.getByRole("button", { name: "New entry" }).first());
  await userEvent.fill(page.getByLabelText("Title"), "Quantum Notes");
  await userEvent.fill(page.getByLabelText("Content"), "Surface codes protect logical qubits.");
  await userEvent.fill(page.getByLabelText("Personal note"), "Check threshold");
  await userEvent.click(page.getByRole("button", { name: "Save entry" }));

  await expect.element(screen.getByRole("button", { name: /Quantum Notes/ })).toBeVisible();

  // 2. Import a UTF-8 Markdown file into Environment A.
  const fileInput = screen.getByTestId("library-import-file-input");
  const mdFile = new File(["# Attention Notes\n\nSparse attention cuts memory cost."], "attn.md", {
    type: "text/markdown",
  });
  await userEvent.upload(fileInput, mdFile);

  await expect.element(screen.getByRole("button", { name: /Attention Notes/ })).toBeVisible();
  await expect.element(screen.getByLabelText("Title")).toHaveValue("Attention Notes");

  // 3. Simulate a concurrent edit on the server (revision 1 -> 2) and trigger conflict banner.
  const envAEntries = mockStore.byEnv.get(ENV_A)!.entries;
  const importedEntry = Array.from(envAEntries.values()).find(
    (entry) => entry.title === "Attention Notes",
  )!;
  envAEntries.set(importedEntry.id, {
    ...importedEntry,
    note: "Server concurrent note v2",
    revision: 2,
  });

  await userEvent.fill(screen.getByLabelText("Personal note"), "Stale client edit");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await expect.element(screen.getByText("Edit conflict detected")).toBeVisible();
  expect(envAEntries.get(importedEntry.id)?.note).toBe("Server concurrent note v2");

  // Reloading fetches revision 2 into the editor without overwriting server data.
  await userEvent.click(screen.getByRole("button", { name: "Reload latest" }));
  await expect
    .element(screen.getByLabelText("Personal note"))
    .toHaveValue("Server concurrent note v2");

  // 4. Multi-select both entries in Environment A and compose a same-environment project draft.
  await userEvent.click(screen.getByRole("checkbox", { name: "Select Quantum Notes" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Select Attention Notes" }));
  await expect.element(screen.getByText("2/5 selected")).toBeVisible();

  await userEvent.fill(
    screen.getByLabelText("Question for draft"),
    "Compare surface codes and sparse attention",
  );
  await userEvent.click(screen.getByRole("button", { name: "Open draft" }));

  await vi.waitFor(() => {
    expect(mockStore.newThreadCalls).toHaveLength(1);
  });
  expect(mockStore.newThreadCalls[0]?.projectRef).toEqual({
    environmentId: ENV_A,
    projectId: PROJECT_A,
  });
  expect(mockStore.newThreadCalls[0]?.prompt).toContain("environmentId: env-a");
  expect(mockStore.newThreadCalls[0]?.prompt).toContain("untrusted reference data");
  expect(mockStore.newThreadCalls[0]?.preservedExistingDraft).toBe(false);

  // Triggering draft again when user text already exists in Project A's draft preserves existing text.
  mockStore.byEnv.get(ENV_A)!.existingDraftTextByProject.set(PROJECT_A, "Existing user draft");
  await userEvent.click(screen.getByRole("button", { name: "Open draft" }));
  await vi.waitFor(() => {
    expect(mockStore.newThreadCalls).toHaveLength(2);
  });
  expect(mockStore.newThreadCalls[1]?.preservedExistingDraft).toBe(true);
  expect(mockStore.byEnv.get(ENV_A)!.existingDraftTextByProject.get(PROJECT_A)).toBe(
    "Existing user draft",
  );

  // 5. Switch to Environment B: zero leakage of Environment A's entries.
  await userEvent.click(screen.getByRole("combobox", { name: "Environment" }));
  await userEvent.click(page.getByRole("option", { name: "Env B" }));

  await expect.element(screen.getByRole("button", { name: /Env B Isolated Entry/ })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Quantum Notes/ }))
    .not.toBeInTheDocument();

  // 6. Switch to Legacy Environment (no researchLibrary capability): graceful degradation, zero RPCs.
  await userEvent.click(screen.getByRole("combobox", { name: "Environment" }));
  await userEvent.click(page.getByRole("option", { name: "Legacy Env" }));

  await expect.element(screen.getByText("Library unavailable on this environment")).toBeVisible();
  expect(mockStore.listCalls.some((call) => call.environmentId === ENV_LEGACY)).toBe(false);
});

it("supports M1b PDF upload with missing-blob degradation and wkb multimodal import", async () => {
  mockStore.reset();
  mockStore.environments.push({
    environmentId: ENV_A,
    label: "Env A",
    supportsLibrary: true,
    canRead: true,
    canWrite: true,
  });
  mockStore.byEnv.set(ENV_A, {
    entries: new Map(),
    existingDraftTextByProject: new Map(),
  });

  await using screen = await render(
    <RegistryProvider>
      <SidebarProvider>
        <LibraryPage requestedEnvironmentId={ENV_A} />
      </SidebarProvider>
    </RegistryProvider>,
  );

  // 1. Upload PDF via file input -> opens with extracted text and missing-blob warning banner
  const pdfInput = screen.container.querySelector<HTMLInputElement>(
    'input[data-testid="library-import-pdf-input"]',
  );
  expect(pdfInput).not.toBeNull();
  const pdfFile = new File(["%PDF-1.4\nminimal"], "quantum-paper.pdf", {
    type: "application/pdf",
  });
  const dt = new DataTransfer();
  dt.items.add(pdfFile);
  Object.defineProperty(pdfInput!, "files", { value: dt.files, configurable: true });
  pdfInput!.dispatchEvent(new Event("change", { bubbles: true }));

  await expect.element(screen.getByRole("button", { name: /quantum-paper/ })).toBeVisible();
  await expect.element(screen.getByText("Original PDF file missing")).toBeVisible();

  // 2. Import multimodal Bilibili talk via wkb dialog
  await userEvent.click(screen.getByRole("button", { name: "Import via wkb" }));
  await userEvent.fill(
    page.getByLabelText("Source URL"),
    "https://www.bilibili.com/video/BV1test123",
  );
  await userEvent.click(page.getByRole("button", { name: "Extract and import" }));

  await expect.element(screen.getByRole("button", { name: /Bilibili Keynote Talk/ })).toBeVisible();
  await expect
    .element(screen.getByLabelText("Captured text"))
    .toHaveValue("[00:00:01] Multimodal transcript extracted by wkb.");
});

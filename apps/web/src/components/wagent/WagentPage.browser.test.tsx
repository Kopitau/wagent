import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  type LibraryEntry,
  type WagentDecideApprovalInput,
  type WagentImportExportToLibraryInput,
  type WagentSendInput,
  type WagentStatusResult,
  type WagentUpdateConfigInput,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { SidebarProvider } from "~/components/ui/sidebar";
import "~/index.css";

import { render } from "../../../test/render";

const ENV_MAIN = EnvironmentId.make("env-wagent-main");
const ENV_LEGACY = EnvironmentId.make("env-wagent-legacy");

const mockState = vi.hoisted(() => {
  const environments: Array<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly supportsWagent: boolean;
    readonly canRead: boolean;
    readonly canOperate: boolean;
    readonly canConfigure: boolean;
  }> = [];

  let currentStatus: WagentStatusResult | null = null;
  const sentPrompts: string[] = [];
  const approvalDecisions: Array<WagentDecideApprovalInput> = [];
  const importedExports: Array<WagentImportExportToLibraryInput> = [];
  const configUpdates: Array<WagentUpdateConfigInput> = [];
  let statusQueryCalls = 0;

  return {
    environments,
    getStatus: () => currentStatus,
    setStatus: (next: WagentStatusResult | null) => {
      currentStatus = next;
    },
    sentPrompts,
    approvalDecisions,
    importedExports,
    configUpdates,
    incrementStatusCalls: () => {
      statusQueryCalls += 1;
    },
    getStatusCalls: () => statusQueryCalls,
    reset: () => {
      environments.length = 0;
      currentStatus = null;
      sentPrompts.length = 0;
      approvalDecisions.length = 0;
      importedExports.length = 0;
      configUpdates.length = 0;
      statusQueryCalls = 0;
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
    environments: mockState.environments.map((env) => ({
      environmentId: env.environmentId,
      label: env.label,
      displayUrl: null,
      relayManaged: false,
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          capabilities: env.supportsWagent ? { wagent: true } : {},
        },
      },
    })),
    presentationById: new Map(),
  }),
  useWagentSupported: () => mockState.environments.some((env) => env.supportsWagent),
})) as never);

const permissionAtomFor = (predicate: (env: (typeof mockState.environments)[number]) => boolean) =>
  Atom.family((envId: EnvironmentId | null) =>
    Atom.make(() => {
      const env = mockState.environments.find((item) => item.environmentId === envId);
      return env ? predicate(env) : false;
    }),
  );

const fakeWagentEnvironment = vi.hoisted(() => ({
  readPermissionAtom: null as unknown,
  refreshStatus: {
    _tag: "refreshStatus",
  },
  send: {
    _tag: "send",
    permissionAtom: null as unknown,
  },
  abort: { _tag: "abort" },
  newSession: { _tag: "newSession" },
  decideApproval: { _tag: "decideApproval" },
  importExportToLibrary: { _tag: "importExportToLibrary" },
  convertToDoc: { _tag: "convertToDoc" },
  updateConfig: {
    _tag: "updateConfig",
    permissionAtom: null as unknown,
  },
}));

fakeWagentEnvironment.readPermissionAtom = permissionAtomFor((env) => env.canRead);
fakeWagentEnvironment.send.permissionAtom = permissionAtomFor((env) => env.canOperate);
fakeWagentEnvironment.updateConfig.permissionAtom = permissionAtomFor((env) => env.canConfigure);

vi.mock(import("../../state/wagent"), (() => ({
  wagentEnvironment: fakeWagentEnvironment as never,
  useAnyWagentReadable: () =>
    mockState.environments.some((env) => env.supportsWagent && env.canRead),
  useWagentLiveStatus: (envId: EnvironmentId | null, enabled: boolean) => {
    if (!enabled || !envId) {
      return { data: undefined, error: undefined, loading: false };
    }
    return { data: mockState.getStatus() ?? undefined, error: undefined, loading: false };
  },
  useWagentStatus: (envId: EnvironmentId | null, enabled: boolean) => {
    if (!enabled || !envId) {
      return { data: undefined, error: undefined, loading: false };
    }
    mockState.incrementStatusCalls();
    return { data: mockState.getStatus() ?? undefined, error: undefined, loading: false };
  },
})) as never);

vi.mock(import("../../state/use-atom-command"), (() => ({
  useAtomCommand:
    (command: { _tag?: string }) =>
    async (arg: { environmentId: EnvironmentId; input: unknown }) => {
      if (command._tag === "send") {
        const input = arg.input as WagentSendInput;
        mockState.sentPrompts.push(input.prompt);
        const current = mockState.getStatus();
        if (current) {
          mockState.setStatus({
            ...current,
            recentRuns: [
              {
                id: "run-new",
                prompt: input.prompt,
                source: "ui",
                status: "completed",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                completedAt: "2026-01-01T00:00:00.000Z",
                output: "Dispatched successfully",
                error: null,
                steps: [],
              },
              ...current.recentRuns,
            ],
          });
        }
        return Exit.succeed({
          run: {
            id: "run-new",
            prompt: input.prompt,
            source: "ui",
            status: "queued",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            completedAt: null,
            output: "",
            error: null,
            steps: [],
          },
        });
      }
      if (command._tag === "decideApproval") {
        const input = arg.input as WagentDecideApprovalInput;
        mockState.approvalDecisions.push(input);
        const current = mockState.getStatus();
        if (current) {
          mockState.setStatus({
            ...current,
            pendingApprovals: current.pendingApprovals.filter((a) => a.id !== input.approvalId),
          });
        }
        return Exit.succeed({
          approval: {
            id: input.approvalId,
            runId: "run-1",
            reason: "删除文件或目录",
            command: "rm -rf ~/Wagent/tmp",
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2026-01-01T00:10:00.000Z",
            status: input.allow ? "approved" : "denied",
            decidedBy: "ui",
            decidedAt: "2026-01-01T00:01:00.000Z",
          },
        });
      }
      if (command._tag === "importExportToLibrary") {
        const input = arg.input as WagentImportExportToLibraryInput;
        mockState.importedExports.push(input);
        const entry: LibraryEntry = {
          id: "lib-1",
          kind: "pdf",
          title: "Attention Paper",
          url: null,
          body: "",
          note: "",
          tags: ["wagent"],
          blobSha256: "abc123",
          blobBytes: 1024,
          blobMissing: false,
          pageCount: 2,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          revision: 1,
        };
        return Exit.succeed({
          entry,
          exportFile: {
            name: "attention.pdf",
            relativePath: input.relativePath,
            bytes: 1024,
            updatedAt: "2026-01-01T00:00:00.000Z",
            kind: "pdf",
          },
        });
      }
      if (command._tag === "updateConfig") {
        const input = arg.input as WagentUpdateConfigInput;
        mockState.configUpdates.push(input);
        return Exit.succeed({ status: mockState.getStatus() });
      }
      return Exit.succeed({});
    },
})) as never);

import { WagentPage } from "./WagentPage";

function seedDefaultStatus(): WagentStatusResult {
  return {
    running: true,
    sessionId: "sess-1",
    activeRun: {
      id: "run-active",
      prompt: "Clean up temporary downloads",
      source: "mcp",
      status: "awaiting_approval",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      output: "",
      error: null,
      steps: [{ timestamp: "2026-01-01T00:00:00.000Z", kind: "tool", text: "bash rm -rf tmp" }],
    },
    queuedRuns: [],
    recentRuns: [],
    pendingApprovals: [
      {
        id: "appr-1",
        runId: "run-active",
        reason: "删除文件或目录",
        command: "rm -rf ~/Wagent/downloads/old",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:10:00.000Z",
        status: "pending",
      },
    ],
    exports: [
      {
        name: "attention.pdf",
        relativePath: "attention.pdf",
        bytes: 4096,
        updatedAt: "2026-01-01T00:00:00.000Z",
        kind: "pdf",
      },
    ],
    config: {
      workspace: "/Users/demo/Wagent",
      model: { provider: "deepseek", id: "deepseek-reasoner", thinking: "high" },
      kbUrl: "https://kb.example.invalid/kb/mcp",
      kbDir: "/Users/demo/kb",
      confirmTimeoutSec: 600,
      telegramEnabled: false,
      allowedUserIds: [42],
      proxy: "",
      agentDir: "/Users/demo/agent",
      hasTelegramBotToken: false,
      hasDeepseekApiKey: true,
      hasWkbToken: false,
    },
    telegramConnected: false,
    agentDirReady: true,
    kbDirReady: true,
  };
}

it("dispatches tasks, handles deletion approval, imports exports to Library, and gates Settings by dual scope", async () => {
  mockState.reset();
  mockState.environments.push(
    {
      environmentId: ENV_MAIN,
      label: "Main Mac",
      supportsWagent: true,
      canRead: true,
      canOperate: true,
      canConfigure: true,
    },
    {
      environmentId: ENV_LEGACY,
      label: "Legacy Server",
      supportsWagent: false,
      canRead: true,
      canOperate: true,
      canConfigure: true,
    },
  );
  mockState.setStatus(seedDefaultStatus());

  const screen = await render(
    <RegistryProvider>
      <SidebarProvider>
        <WagentPage />
      </SidebarProvider>
    </RegistryProvider>,
  );
  try {
    // 1. Deletion approval banner renders command and Approve/Reject actions
    await expect.element(page.getByTestId("wagent-approval-appr-1")).toBeVisible();
    await expect.element(page.getByText("rm -rf ~/Wagent/downloads/old")).toBeVisible();

    await userEvent.click(page.getByTestId("wagent-reject-appr-1"));
    expect(mockState.approvalDecisions).toEqual([{ approvalId: "appr-1", allow: false }]);

    // 2. Dispatch a personal task
    await userEvent.fill(page.getByTestId("wagent-prompt-input"), "Summarize today's papers");
    await userEvent.click(page.getByTestId("wagent-send-btn"));
    expect(mockState.sentPrompts).toEqual(["Summarize today's papers"]);

    // 3. One-click import export into Research Library
    await userEvent.click(page.getByTestId("wagent-import-export-attention.pdf"));
    expect(mockState.importedExports).toEqual([{ relativePath: "attention.pdf" }]);

    // 4. Open Settings dialog (visible because canConfigure is true) and save
    await userEvent.click(page.getByTestId("wagent-open-settings-btn"));
    await expect.element(page.getByTestId("wagent-settings-dialog")).toBeVisible();
    await userEvent.click(page.getByTestId("wagent-save-settings-btn"));
    expect(mockState.configUpdates).toHaveLength(1);
  } finally {
    await screen.unmount();
  }
});

it("degrades gracefully on legacy environments without capability and hides Settings without dual config scope", async () => {
  mockState.reset();
  mockState.environments.push({
    environmentId: ENV_LEGACY,
    label: "Legacy Server",
    supportsWagent: false,
    canRead: true,
    canOperate: true,
    canConfigure: false,
  });

  const legacyScreen = await render(
    <RegistryProvider>
      <SidebarProvider>
        <WagentPage />
      </SidebarProvider>
    </RegistryProvider>,
  );
  try {
    await expect.element(page.getByTestId("wagent-unsupported-alert")).toBeVisible();
    expect(mockState.getStatusCalls()).toBe(0);
  } finally {
    await legacyScreen.unmount();
  }

  // Operator without settings:write + providers:manage cannot see Settings button
  mockState.reset();
  mockState.environments.push({
    environmentId: ENV_MAIN,
    label: "Main Mac",
    supportsWagent: true,
    canRead: true,
    canOperate: true,
    canConfigure: false,
  });
  mockState.setStatus(seedDefaultStatus());

  const operatorScreen = await render(
    <RegistryProvider>
      <SidebarProvider>
        <WagentPage />
      </SidebarProvider>
    </RegistryProvider>,
  );
  try {
    await expect.element(page.getByTestId("wagent-send-btn")).toBeVisible();
    await expect.element(page.getByTestId("wagent-open-settings-btn")).not.toBeInTheDocument();
  } finally {
    await operatorScreen.unmount();
  }
});

import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  WagentConfigView,
  WagentExportFile,
  WagentPendingApproval,
  WagentRunRecord,
  WagentStatusResult,
  WagentThinkingLevel,
  WagentUpdateConfigInput,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  FileDownIcon,
  FileTextIcon,
  LockIcon,
  RotateCcwIcon,
  SendIcon,
  SettingsIcon,
  ShieldAlertIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { useAtomCommand } from "~/state/use-atom-command";
import { m } from "~/i18n/messages";
import { useEnvironments } from "~/state/environments";
import { useWagentLiveStatus, useWagentStatus, wagentEnvironment } from "~/state/wagent";

const THINKING_LEVELS: ReadonlyArray<WagentThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function resolveActiveWagentEnvironmentId(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly supportsWagent: boolean;
    readonly connected: boolean;
  }>,
  selectedEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    environments.some((env) => env.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  const connectedSupported = environments.find((env) => env.supportsWagent && env.connected);
  if (connectedSupported) return connectedSupported.environmentId;
  const anySupported = environments.find((env) => env.supportsWagent);
  if (anySupported) return anySupported.environmentId;
  return environments[0]?.environmentId ?? null;
}

function formatRunStatusBadge(
  status: WagentRunRecord["status"],
  gt: ReturnType<typeof useGT>,
): {
  readonly label: string;
  readonly variant: "default" | "secondary" | "destructive" | "outline";
} {
  switch (status) {
    case "running":
      return { label: gt("Running"), variant: "default" };
    case "awaiting_approval":
      return { label: gt("Awaiting approval"), variant: "destructive" };
    case "queued":
      return { label: gt("Queued"), variant: "secondary" };
    case "completed":
      return { label: gt("Completed"), variant: "secondary" };
    case "cancelled":
      return { label: gt("Cancelled"), variant: "outline" };
    case "failed":
      return { label: gt("Failed"), variant: "destructive" };
  }
}

function WagentApprovalSection(props: {
  readonly approvals: ReadonlyArray<WagentPendingApproval>;
  readonly canOperate: boolean;
  readonly busyApprovalId: string | null;
  readonly onDecide: (approvalId: string, allow: boolean) => void;
}) {
  if (props.approvals.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="wagent-approvals-section">
      {props.approvals.map((approval) => {
        const isBusy = props.busyApprovalId === approval.id;
        return (
          <Alert key={approval.id} variant="warning" data-testid={`wagent-approval-${approval.id}`}>
            <ShieldAlertIcon />
            <AlertTitle>
              <T>
                Deletion confirmation required (<Var>{approval.reason}</Var>)
              </T>
            </AlertTitle>
            <AlertDescription>
              <div className="space-y-3">
                <p>
                  <T>
                    Wagent paused a destructive command. Approve or reject here or via Telegram. If
                    no decision is made before expiry, the command is automatically denied.
                  </T>
                </p>
                <pre className="overflow-x-auto rounded-md border bg-muted/60 p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
                  {approval.command}
                </pre>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!props.canOperate || isBusy}
                    onClick={() => props.onDecide(approval.id, true)}
                    data-testid={`wagent-approve-${approval.id}`}
                  >
                    <CheckIcon className="size-3.5" />
                    <T>Approve deletion</T>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!props.canOperate || isBusy}
                    onClick={() => props.onDecide(approval.id, false)}
                    data-testid={`wagent-reject-${approval.id}`}
                  >
                    <XIcon className="size-3.5" />
                    <T>Reject</T>
                  </Button>
                </div>
              </div>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}

function WagentSettingsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly config: WagentConfigView;
  readonly saving: boolean;
  readonly onSave: (input: WagentUpdateConfigInput) => Promise<void>;
}) {
  const gt = useGT();
  const [workspace, setWorkspace] = useState(props.config.workspace);
  const [agentDir, setAgentDir] = useState(props.config.agentDir);
  const [kbDir, setKbDir] = useState(props.config.kbDir);
  const [kbUrl, setKbUrl] = useState(props.config.kbUrl);
  const [provider, setProvider] = useState(props.config.model.provider);
  const [modelId, setModelId] = useState(props.config.model.id);
  const [thinking, setThinking] = useState<WagentThinkingLevel>(props.config.model.thinking);
  const [confirmTimeoutSec, setConfirmTimeoutSec] = useState(
    String(props.config.confirmTimeoutSec),
  );
  const [proxy, setProxy] = useState(props.config.proxy);
  const [telegramEnabled, setTelegramEnabled] = useState(props.config.telegramEnabled);
  const [allowedUsersText, setAllowedUsersText] = useState(props.config.allowedUserIds.join(", "));

  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [clearTelegramBotToken, setClearTelegramBotToken] = useState(false);
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [clearDeepseekApiKey, setClearDeepseekApiKey] = useState(false);
  const [wkbToken, setWkbToken] = useState("");
  const [clearWkbToken, setClearWkbToken] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const parsedTimeout = Number.parseInt(confirmTimeoutSec.trim(), 10);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout < 10 || parsedTimeout > 3600) {
      setValidationError(gt("Confirm timeout must be between 10 and 3600 seconds."));
      return;
    }
    const parsedUsers = allowedUsersText
      .split(/[,\s]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => Number.parseInt(part, 10));
    if (parsedUsers.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      setValidationError(gt("Allowed Telegram user IDs must be positive integers."));
      return;
    }

    setValidationError(null);
    const payload: WagentUpdateConfigInput = {
      workspace: workspace.trim(),
      agentDir: agentDir.trim(),
      kbDir: kbDir.trim(),
      kbUrl: kbUrl.trim(),
      model: {
        provider: provider.trim(),
        id: modelId.trim(),
        thinking,
      },
      confirmTimeoutSec: parsedTimeout,
      proxy: proxy.trim(),
      telegramEnabled,
      allowedUserIds: parsedUsers,
      ...(clearTelegramBotToken
        ? { telegramBotToken: null }
        : telegramBotToken.trim()
          ? { telegramBotToken: telegramBotToken.trim() }
          : {}),
      ...(clearDeepseekApiKey
        ? { deepseekApiKey: null }
        : deepseekApiKey.trim()
          ? { deepseekApiKey: deepseekApiKey.trim() }
          : {}),
      ...(clearWkbToken
        ? { wkbToken: null }
        : wkbToken.trim()
          ? { wkbToken: wkbToken.trim() }
          : {}),
    };
    await props.onSave(payload);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl" data-testid="wagent-settings-dialog">
        <DialogHeader>
          <DialogTitle>
            <T>Wagent settings</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Configure Wagent workspace, Pi model, optional Telegram channel, and encrypted server
              secrets. Plaintext tokens are never returned to clients.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {validationError ? (
              <Alert variant="error">
                <AlertTriangleIcon />
                <AlertDescription>{validationError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wagent-workspace">
                  <T>Workspace directory</T>
                </Label>
                <Input
                  id="wagent-workspace"
                  value={workspace}
                  onChange={(event) => setWorkspace(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wagent-agent-dir">
                  <T>Wagent Pi agent directory</T>
                </Label>
                <Input
                  id="wagent-agent-dir"
                  value={agentDir}
                  onChange={(event) => setAgentDir(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wagent-kb-dir">
                  <T>Local wkb directory</T>
                </Label>
                <Input
                  id="wagent-kb-dir"
                  value={kbDir}
                  onChange={(event) => setKbDir(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wagent-kb-url">
                  <T>Remote wkb MCP URL</T>
                </Label>
                <Input
                  id="wagent-kb-url"
                  value={kbUrl}
                  onChange={(event) => setKbUrl(event.target.value)}
                />
              </div>
            </div>

            <Separator />

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="wagent-model-provider">
                  <T>Model provider</T>
                </Label>
                <Input
                  id="wagent-model-provider"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wagent-model-id">
                  <T>Model ID</T>
                </Label>
                <Input
                  id="wagent-model-id"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>
                  <T>Thinking level</T>
                </Label>
                <Select
                  value={thinking}
                  onValueChange={(value) => {
                    if (value) setThinking(value as WagentThinkingLevel);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {THINKING_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="wagent-timeout">
                  <T>Deletion confirm timeout (seconds)</T>
                </Label>
                <Input
                  id="wagent-timeout"
                  type="number"
                  min={10}
                  max={3600}
                  value={confirmTimeoutSec}
                  onChange={(event) => setConfirmTimeoutSec(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wagent-proxy">
                  <T>HTTP/HTTPS proxy (optional)</T>
                </Label>
                <Input
                  id="wagent-proxy"
                  placeholder={gt("http://127.0.0.1:7890")}
                  value={proxy}
                  onChange={(event) => setProxy(event.target.value)}
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="wagent-telegram-enabled"
                  checked={telegramEnabled}
                  onCheckedChange={(checked) => setTelegramEnabled(checked === true)}
                />
                <Label htmlFor="wagent-telegram-enabled">
                  <T>Enable optional Telegram Bot channel</T>
                </Label>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wagent-allowed-users">
                  <T>Allowed Telegram user IDs (comma separated)</T>
                </Label>
                <Input
                  id="wagent-allowed-users"
                  placeholder={gt("e.g. 123456789")}
                  value={allowedUsersText}
                  onChange={(event) => setAllowedUsersText(event.target.value)}
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="wagent-deepseek-key">
                    <T>DeepSeek API Key</T>
                  </Label>
                  <Badge variant={props.config.hasDeepseekApiKey ? "secondary" : "outline"}>
                    {props.config.hasDeepseekApiKey ? <T>Configured</T> : <T>Not set</T>}
                  </Badge>
                </div>
                <Input
                  id="wagent-deepseek-key"
                  type="password"
                  placeholder={gt("Leave blank to keep existing secret")}
                  value={deepseekApiKey}
                  disabled={clearDeepseekApiKey}
                  onChange={(event) => setDeepseekApiKey(event.target.value)}
                />
                {props.config.hasDeepseekApiKey ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="wagent-clear-deepseek"
                      checked={clearDeepseekApiKey}
                      onCheckedChange={(checked) => setClearDeepseekApiKey(checked === true)}
                    />
                    <Label htmlFor="wagent-clear-deepseek">
                      <T>Clear stored DeepSeek API key</T>
                    </Label>
                  </div>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="wagent-telegram-token">
                    <T>Telegram Bot Token</T>
                  </Label>
                  <Badge variant={props.config.hasTelegramBotToken ? "secondary" : "outline"}>
                    {props.config.hasTelegramBotToken ? <T>Configured</T> : <T>Not set</T>}
                  </Badge>
                </div>
                <Input
                  id="wagent-telegram-token"
                  type="password"
                  placeholder={gt("Leave blank to keep existing secret")}
                  value={telegramBotToken}
                  disabled={clearTelegramBotToken}
                  onChange={(event) => setTelegramBotToken(event.target.value)}
                />
                {props.config.hasTelegramBotToken ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="wagent-clear-telegram"
                      checked={clearTelegramBotToken}
                      onCheckedChange={(checked) => setClearTelegramBotToken(checked === true)}
                    />
                    <Label htmlFor="wagent-clear-telegram">
                      <T>Clear stored Telegram bot token</T>
                    </Label>
                  </div>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="wagent-wkb-token">
                    <T>wkb MCP Bearer Token</T>
                  </Label>
                  <Badge variant={props.config.hasWkbToken ? "secondary" : "outline"}>
                    {props.config.hasWkbToken ? <T>Configured</T> : <T>Not set</T>}
                  </Badge>
                </div>
                <Input
                  id="wagent-wkb-token"
                  type="password"
                  placeholder={gt("Leave blank to keep existing secret")}
                  value={wkbToken}
                  disabled={clearWkbToken}
                  onChange={(event) => setWkbToken(event.target.value)}
                />
                {props.config.hasWkbToken ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="wagent-clear-wkb"
                      checked={clearWkbToken}
                      onCheckedChange={(checked) => setClearWkbToken(checked === true)}
                    />
                    <Label htmlFor="wagent-clear-wkb">
                      <T>Clear stored wkb token</T>
                    </Label>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button
            disabled={props.saving}
            onClick={() => void handleSubmit()}
            data-testid="wagent-save-settings-btn"
          >
            {props.saving ? <Spinner /> : null}
            <T>Save settings</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function WagentPage() {
  const gt = useGT();
  const { environments } = useEnvironments();

  const [selectedEnvId, setSelectedEnvId] = useState<EnvironmentId | null>(null);
  const [promptText, setPromptText] = useState("");
  const [convertSource, setConvertSource] = useState("");
  const [convertPdf, setConvertPdf] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [sending, setSending] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const activeEnvironmentId = resolveActiveWagentEnvironmentId(
    environments.map((env) => ({
      environmentId: env.environmentId,
      supportsWagent: env.serverConfig?.environment.capabilities.wagent === true,
      connected: env.connection.phase === "connected",
    })),
    selectedEnvId,
  );

  const activeEnvironment =
    environments.find((env) => env.environmentId === activeEnvironmentId) ?? null;
  const supportsWagent = activeEnvironment?.serverConfig?.environment.capabilities.wagent === true;

  const canRead = useAtomValue(wagentEnvironment.readPermissionAtom(activeEnvironmentId));
  const canOperate = useAtomValue(wagentEnvironment.send.permissionAtom(activeEnvironmentId));
  const canConfigure = useAtomValue(
    wagentEnvironment.updateConfig.permissionAtom(activeEnvironmentId),
  );

  const queryEnabled = activeEnvironmentId !== null && supportsWagent && canRead;
  const liveQuery = useWagentLiveStatus(activeEnvironmentId, queryEnabled);
  const statusQuery = useWagentStatus(activeEnvironmentId, queryEnabled);
  const status: WagentStatusResult | null = liveQuery.data ?? statusQuery.data ?? null;

  const sendCommand = useAtomCommand(wagentEnvironment.send, { reportFailure: false });
  const abortCommand = useAtomCommand(wagentEnvironment.abort, { reportFailure: false });
  const newSessionCommand = useAtomCommand(wagentEnvironment.newSession, { reportFailure: false });
  const decideApprovalCommand = useAtomCommand(wagentEnvironment.decideApproval, {
    reportFailure: false,
  });
  const importExportCommand = useAtomCommand(wagentEnvironment.importExportToLibrary, {
    reportFailure: false,
  });
  const convertToDocCommand = useAtomCommand(wagentEnvironment.convertToDoc, {
    reportFailure: false,
  });
  const updateConfigCommand = useAtomCommand(wagentEnvironment.updateConfig, {
    reportFailure: false,
  });
  const refreshStatusCommand = useAtomCommand(wagentEnvironment.refreshStatus, {
    reportFailure: false,
  });

  const handleSend = async () => {
    if (!activeEnvironmentId || !canOperate) return;
    const trimmed = promptText.trim();
    if (!trimmed) return;
    setSending(true);
    const result = await sendCommand({
      environmentId: activeEnvironmentId,
      input: { prompt: trimmed },
    });
    setSending(false);
    if (result._tag === "Success") {
      setPromptText("");
      toastManager.add({
        type: "success",
        title: gt("Task dispatched to Wagent"),
      });
    } else {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Failed to dispatch task"),
        description: errorDisplayMessage(failure, m),
      });
    }
  };

  const handleAbort = async () => {
    if (!activeEnvironmentId || !canOperate) return;
    const result = await abortCommand({
      environmentId: activeEnvironmentId,
      input: {},
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "info",
        title: result.value.aborted
          ? gt("Stop requested for active Wagent run")
          : gt("No active Wagent run to stop"),
      });
    } else {
      toastManager.add({
        type: "error",
        title: gt("Failed to stop Wagent run"),
        description: errorDisplayMessage(squashAtomCommandFailure(result), m),
      });
    }
  };

  const handleNewSession = async () => {
    if (!activeEnvironmentId || !canOperate) return;
    const result = await newSessionCommand({
      environmentId: activeEnvironmentId,
      input: undefined,
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Started new Wagent session"),
      });
    } else {
      toastManager.add({
        type: "error",
        title: gt("Unable to reset Wagent session"),
        description: errorDisplayMessage(squashAtomCommandFailure(result), m),
      });
    }
  };

  const handleDecideApproval = async (approvalId: string, allow: boolean) => {
    if (!activeEnvironmentId || !canOperate) return;
    setBusyApprovalId(approvalId);
    const result = await decideApprovalCommand({
      environmentId: activeEnvironmentId,
      input: { approvalId, allow },
    });
    setBusyApprovalId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: allow ? "success" : "info",
        title: allow ? gt("Deletion approved") : gt("Deletion rejected"),
      });
    } else {
      toastManager.add({
        type: "error",
        title: gt("Failed to record deletion decision"),
        description: errorDisplayMessage(squashAtomCommandFailure(result), m),
      });
    }
  };

  const handleConvertToDoc = async () => {
    if (!activeEnvironmentId || !canOperate) return;
    const trimmed = convertSource.trim();
    if (!trimmed) return;
    setConverting(true);
    const result = await convertToDocCommand({
      environmentId: activeEnvironmentId,
      input: { source: trimmed, pdf: convertPdf },
    });
    setConverting(false);
    if (result._tag === "Success") {
      setConvertSource("");
      toastManager.add({
        type: "success",
        title: gt("Exported to Wagent workspace"),
        description: result.value.title,
      });
    } else {
      toastManager.add({
        type: "error",
        title: gt("Conversion failed"),
        description: errorDisplayMessage(squashAtomCommandFailure(result), m),
      });
    }
  };

  const handleImportExport = async (file: WagentExportFile) => {
    if (!activeEnvironmentId || !canOperate) return;
    setImportingPath(file.relativePath);
    const result = await importExportCommand({
      environmentId: activeEnvironmentId,
      input: { relativePath: file.relativePath },
    });
    setImportingPath(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Imported into Research Library"),
        description: result.value.entry.title,
      });
    } else {
      toastManager.add({
        type: "error",
        title: gt("Import to library failed"),
        description: errorDisplayMessage(squashAtomCommandFailure(result), m),
      });
    }
  };

  const handleSaveSettings = async (input: WagentUpdateConfigInput) => {
    if (!activeEnvironmentId || !canConfigure) return;
    setSavingSettings(true);
    const result = await updateConfigCommand({
      environmentId: activeEnvironmentId,
      input,
    });
    setSavingSettings(false);
    if (result._tag === "Success") {
      setSettingsOpen(false);
      toastManager.add({
        type: "success",
        title: gt("Wagent settings updated"),
      });
    } else {
      toastManager.add({
        type: "error",
        title: gt("Failed to save Wagent settings"),
        description: errorDisplayMessage(squashAtomCommandFailure(result), m),
      });
    }
  };

  const handleRefresh = () => {
    if (!activeEnvironmentId || !queryEnabled) return;
    void refreshStatusCommand({
      environmentId: activeEnvironmentId,
      input: undefined,
    });
  };

  const statusError = statusQuery.error ?? liveQuery.error;

  return (
    <SidebarInset className="min-h-0 flex-1 overflow-hidden">
      <div className="flex h-full min-h-0 flex-col">
        <WorkspacePageHeader electron={isElectron} className="justify-between border-b">
          <WorkspaceBreadcrumb ariaLabel={gt("Wagent breadcrumb")}>
            <WorkspaceBreadcrumbItem current>
              <span className="inline-flex items-center gap-1.5 truncate">
                <BotIcon className="size-3.5 shrink-0" />
                <T>Wagent</T>
              </span>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="flex flex-wrap items-center gap-2">
            {environments.length > 1 ? (
              <Select
                value={activeEnvironmentId ?? undefined}
                onValueChange={(value) => {
                  if (value) setSelectedEnvId(value as EnvironmentId);
                }}
              >
                <SelectTrigger size="sm" data-testid="wagent-env-select">
                  <SelectValue placeholder={gt("Environment")} />
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((env) => (
                    <SelectItem key={env.environmentId} value={env.environmentId}>
                      {env.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {queryEnabled ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleRefresh}
                aria-label={gt("Refresh Wagent status")}
              >
                <RefreshIcon className="size-3.5" />
              </Button>
            ) : null}
            {queryEnabled && status ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canOperate || status.running}
                onClick={() => void handleNewSession()}
                data-testid="wagent-new-session-btn"
              >
                <RotateCcwIcon className="size-3.5" />
                <T>New session</T>
              </Button>
            ) : null}
            {queryEnabled && status && canConfigure ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSettingsOpen(true)}
                data-testid="wagent-open-settings-btn"
              >
                <SettingsIcon className="size-3.5" />
                <T>Settings</T>
              </Button>
            ) : null}
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
            {activeEnvironment === null ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BotIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    <T>No environment connected</T>
                  </EmptyTitle>
                  <EmptyDescription>
                    <T>Connect an environment to dispatch personal tasks to Wagent.</T>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : !supportsWagent ? (
              <Alert data-testid="wagent-unsupported-alert">
                <AlertTriangleIcon />
                <AlertTitle>
                  <T>Wagent is not supported on this environment</T>
                </AlertTitle>
                <AlertDescription>
                  <T>
                    The selected environment does not advertise the Wagent dispatcher capability.
                    Switch to an updated environment to use Wagent.
                  </T>
                </AlertDescription>
              </Alert>
            ) : !canRead ? (
              <Alert data-testid="wagent-permission-alert">
                <LockIcon />
                <AlertTitle>
                  <T>Permission required</T>
                </AlertTitle>
                <AlertDescription>
                  <T>
                    Your session does not have orchestration read permission to inspect Wagent on
                    this environment.
                  </T>
                </AlertDescription>
              </Alert>
            ) : statusError && !status ? (
              <Alert variant="error">
                <AlertTriangleIcon />
                <AlertTitle>
                  <T>Failed to load Wagent status</T>
                </AlertTitle>
                <AlertDescription>{errorDisplayMessage(statusError, m)}</AlertDescription>
              </Alert>
            ) : !status ? (
              <div className="flex items-center justify-center py-16">
                <Spinner />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-base font-semibold">
                        <T>Wagent Personal Digital Twin</T>
                      </h1>
                      <Badge variant={status.running ? "default" : "secondary"}>
                        {status.running ? <T>Running</T> : <T>Idle</T>}
                      </Badge>
                      <Badge variant={status.telegramConnected ? "secondary" : "outline"}>
                        {status.telegramConnected ? <T>Telegram connected</T> : <T>Telegram off</T>}
                      </Badge>
                      <Badge variant={status.agentDirReady ? "secondary" : "outline"}>
                        {status.agentDirReady ? (
                          <T>Pi runtime ready</T>
                        ) : (
                          <T>Pi runtime unlinked</T>
                        )}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <T>
                        Isolated from Coding Harnesses. Workspace:{" "}
                        <Var>{status.config.workspace}</Var>
                        {" · "}Model: <Var>{status.config.model.provider}</Var>/
                        <Var>{status.config.model.id}</Var>
                      </T>
                    </p>
                  </div>
                  {status.running && canOperate ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void handleAbort()}
                      data-testid="wagent-stop-btn"
                    >
                      <SquareIcon className="size-3.5" />
                      <T>Stop task</T>
                    </Button>
                  ) : null}
                </div>

                <WagentApprovalSection
                  approvals={status.pendingApprovals}
                  canOperate={canOperate}
                  busyApprovalId={busyApprovalId}
                  onDecide={(approvalId, allow) => void handleDecideApproval(approvalId, allow)}
                />

                <div className="grid gap-5 lg:grid-cols-3">
                  <div className="space-y-5 lg:col-span-2">
                    <div className="space-y-3 rounded-lg border bg-card p-4">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="wagent-prompt-input">
                          <T>Dispatch a task to Wagent</T>
                        </Label>
                        {!canOperate ? (
                          <Badge variant="outline">
                            <T>Read-only session</T>
                          </Badge>
                        ) : null}
                      </div>
                      <Textarea
                        id="wagent-prompt-input"
                        rows={3}
                        placeholder={gt(
                          "Ask Wagent to fetch articles, organize ~/Wagent, query wkb, or run personal automation...",
                        )}
                        value={promptText}
                        disabled={!canOperate || sending}
                        onChange={(event) => setPromptText(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                            event.preventDefault();
                            void handleSend();
                          }
                        }}
                        data-testid="wagent-prompt-input"
                      />
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          <T>
                            Tasks can also be dispatched by T3 Workflows and MCP via
                            wagent_dispatch.
                          </T>
                        </span>
                        <Button
                          size="sm"
                          disabled={!canOperate || sending || promptText.trim().length === 0}
                          onClick={() => void handleSend()}
                          data-testid="wagent-send-btn"
                        >
                          {sending ? <Spinner /> : <SendIcon className="size-3.5" />}
                          <T>Send to Wagent</T>
                        </Button>
                      </div>
                    </div>

                    {status.activeRun ? (
                      <div
                        className="space-y-3 rounded-lg border bg-card p-4"
                        data-testid="wagent-active-run"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Spinner />
                            <span className="text-sm font-medium">
                              <T>Active run</T>
                            </span>
                            <Badge variant="outline">{status.activeRun.source}</Badge>
                            <Badge
                              variant={formatRunStatusBadge(status.activeRun.status, gt).variant}
                            >
                              {formatRunStatusBadge(status.activeRun.status, gt).label}
                            </Badge>
                          </div>
                        </div>
                        <p className="text-sm">{status.activeRun.prompt}</p>
                        {status.activeRun.steps.length > 0 ? (
                          <div className="space-y-1 rounded-md border bg-muted/40 p-2.5 font-mono text-xs">
                            {status.activeRun.steps.slice(-8).map((step) => (
                              <div
                                key={`${step.timestamp}-${step.kind}-${step.text}`}
                                className="truncate"
                              >
                                [{step.kind}] {step.text}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {status.activeRun.output ? (
                          <pre className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
                            {status.activeRun.output}
                          </pre>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="space-y-3 rounded-lg border bg-card p-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">
                          <T>Recent runs</T>
                        </h2>
                        <Badge variant="secondary">{status.recentRuns.length}</Badge>
                      </div>
                      {status.recentRuns.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          <T>No completed Wagent runs yet.</T>
                        </p>
                      ) : (
                        <div className="space-y-2.5" data-testid="wagent-recent-runs">
                          {status.recentRuns.map((run) => {
                            const badge = formatRunStatusBadge(run.status, gt);
                            return (
                              <div
                                key={run.id}
                                className="space-y-1.5 rounded-md border p-3"
                                data-testid={`wagent-run-${run.id}`}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-sm font-medium line-clamp-1">
                                    {run.prompt}
                                  </span>
                                  <div className="flex items-center gap-1.5">
                                    <Badge variant="outline">{run.source}</Badge>
                                    <Badge variant={badge.variant}>{badge.label}</Badge>
                                  </div>
                                </div>
                                {run.output ? (
                                  <p className="text-xs text-muted-foreground whitespace-pre-wrap line-clamp-4">
                                    {run.output}
                                  </p>
                                ) : null}
                                {run.error ? (
                                  <p className="text-xs text-destructive">{run.error}</p>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-5">
                    <div className="space-y-3 rounded-lg border bg-card p-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">
                          <T>Convert URL or file via wkb</T>
                        </h2>
                        <Badge variant={status.kbDirReady ? "secondary" : "outline"}>
                          {status.kbDirReady ? <T>wkb ready</T> : <T>wkb missing</T>}
                        </Badge>
                      </div>
                      <Input
                        placeholder={gt("https://... or ~/Wagent/inbox/file")}
                        value={convertSource}
                        disabled={!canOperate || converting}
                        onChange={(event) => setConvertSource(event.target.value)}
                        data-testid="wagent-convert-input"
                      />
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id="wagent-convert-pdf"
                            checked={convertPdf}
                            onCheckedChange={(checked) => setConvertPdf(checked === true)}
                          />
                          <Label htmlFor="wagent-convert-pdf">
                            <T>Also export PDF</T>
                          </Label>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canOperate || converting || convertSource.trim().length === 0}
                          onClick={() => void handleConvertToDoc()}
                          data-testid="wagent-convert-btn"
                        >
                          {converting ? <Spinner /> : <FileDownIcon className="size-3.5" />}
                          <T>Convert</T>
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-3 rounded-lg border bg-card p-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-sm font-semibold">
                          <T>Workspace exports</T>
                        </h2>
                        <Badge variant="secondary">{status.exports.length}</Badge>
                      </div>
                      {status.exports.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          <T>
                            Files generated in ~/Wagent/exports appear here for one-click import
                            into Research Library.
                          </T>
                        </p>
                      ) : (
                        <div className="space-y-2" data-testid="wagent-exports-list">
                          {status.exports.map((file) => {
                            const canImport =
                              canOperate &&
                              (file.kind === "pdf" ||
                                file.kind === "markdown" ||
                                file.kind === "text");
                            const isImporting = importingPath === file.relativePath;
                            return (
                              <div
                                key={file.relativePath}
                                className="flex items-center justify-between gap-2 rounded-md border p-2.5"
                                data-testid={`wagent-export-${file.relativePath}`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                    <span className="truncate text-xs font-medium">
                                      {file.name}
                                    </span>
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                                    <Badge variant="outline">{file.kind}</Badge>
                                    <span>{formatBytes(file.bytes)}</span>
                                  </div>
                                </div>
                                {canImport ? (
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    disabled={isImporting}
                                    onClick={() => void handleImportExport(file)}
                                    data-testid={`wagent-import-export-${file.relativePath}`}
                                  >
                                    {isImporting ? (
                                      <Spinner />
                                    ) : (
                                      <BookOpenIcon className="size-3" />
                                    )}
                                    <T>Import</T>
                                  </Button>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {settingsOpen ? (
                  <WagentSettingsDialog
                    open={settingsOpen}
                    onOpenChange={setSettingsOpen}
                    config={status.config}
                    saving={savingSettings}
                    onSave={handleSaveSettings}
                  />
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

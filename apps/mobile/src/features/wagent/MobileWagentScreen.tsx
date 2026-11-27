import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, WagentPendingApproval } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { useState } from "react";
import { Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { ENVIRONMENT_REQUEST_INTERRUPTED } from "../../state/query";
import {
  mergeWagentStatus,
  resolveMobileWagentTarget,
  useMobileWagentLiveStatus,
  useMobileWagentReadPermission,
  useMobileWagentStatus,
  useMobileWagentWritePermission,
  wagentEnvironment,
} from "../../state/wagent";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function MobileWagentRouteScreen() {
  const gt = useGT();
  const messages = useMessages();
  const insets = useSafeAreaInsets();
  const { environments, networkStatus } = useEnvironments();

  const [preferredEnvId, setPreferredEnvId] = useState<EnvironmentId | null>(null);
  const [promptsByEnv, setPromptsByEnv] = useState<Readonly<Record<string, string>>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const connectedEnvironments = environments.filter(
    (entry) => entry.connection.phase === "connected" && entry.serverConfig !== null,
  );
  const selectableEnvironments = environments.filter(
    (entry) =>
      (entry.connection.phase === "connected" && entry.serverConfig !== null) ||
      entry.environmentId === preferredEnvId,
  );
  const resolution = resolveMobileWagentTarget(environments, preferredEnvId);
  const activeEnvironment = resolution.kind === "ready" ? resolution.environment : null;
  const activeEnvironmentId = activeEnvironment?.environmentId ?? null;
  const prompt = activeEnvironmentId !== null ? (promptsByEnv[activeEnvironmentId] ?? "") : "";

  function updatePromptForActiveEnv(nextValue: string) {
    if (activeEnvironmentId === null) return;
    if (preferredEnvId === null && nextValue.length > 0) {
      setPreferredEnvId(activeEnvironmentId);
    }
    setPromptsByEnv((prev) => ({ ...prev, [activeEnvironmentId]: nextValue }));
  }

  const canRead = useMobileWagentReadPermission(activeEnvironmentId);
  const canWrite = useMobileWagentWritePermission(activeEnvironmentId);
  const enabled = activeEnvironmentId !== null && canRead;

  const liveQuery = useMobileWagentLiveStatus(activeEnvironmentId, enabled);
  const fallbackQuery = useMobileWagentStatus(activeEnvironmentId, enabled);
  const status = mergeWagentStatus(liveQuery.data, fallbackQuery.data);

  const sendTask = useAtomCommand(wagentEnvironment.send, {
    label: "mobile wagent send",
    reportFailure: false,
  });
  const abortRun = useAtomCommand(wagentEnvironment.abort, {
    label: "mobile wagent abort",
    reportFailure: false,
  });
  const newSession = useAtomCommand(wagentEnvironment.newSession, {
    label: "mobile wagent new session",
    reportFailure: false,
  });
  const decideApproval = useAtomCommand(wagentEnvironment.decideApproval, {
    label: "mobile wagent decide approval",
    reportFailure: false,
  });
  const importExport = useAtomCommand(wagentEnvironment.importExportToLibrary, {
    label: "mobile wagent import export",
    reportFailure: false,
  });

  const offline = networkStatus === "offline";

  function handleCommandError(result: { readonly _tag: "Failure"; readonly cause: unknown }) {
    if (isAtomCommandInterrupted(result as never)) {
      setActionError(messages(ENVIRONMENT_REQUEST_INTERRUPTED));
      return;
    }
    const failure = squashAtomCommandFailure(result as never);
    setActionError(
      failure instanceof Error
        ? (errorDisplayMessage(failure, messages) ?? failure.message)
        : gt("Wagent command failed. Check your connection and try again."),
    );
  }

  async function handleSend() {
    if (activeEnvironmentId === null || busyAction !== null) return;
    const targetEnvironmentId = activeEnvironmentId;
    const trimmed = (promptsByEnv[targetEnvironmentId] ?? "").trim();
    if (trimmed.length === 0) return;
    setPreferredEnvId(targetEnvironmentId);
    setBusyAction("send");
    setActionError(null);
    setActionNotice(null);
    const result = await sendTask({
      environmentId: targetEnvironmentId,
      input: { prompt: trimmed },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      handleCommandError(result);
      return;
    }
    setPromptsByEnv((prev) => ({ ...prev, [targetEnvironmentId]: "" }));
    setActionNotice(gt("Task dispatched to Wagent."));
  }

  async function handleAbort() {
    if (activeEnvironmentId === null || busyAction !== null) return;
    setBusyAction("abort");
    setActionError(null);
    const result = await abortRun({
      environmentId: activeEnvironmentId,
      input: { runId: status?.activeRun?.id },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      handleCommandError(result);
      return;
    }
    setActionNotice(result.value.aborted ? gt("Abort requested.") : gt("No active run to abort."));
  }

  async function handleNewSession() {
    if (activeEnvironmentId === null || busyAction !== null) return;
    setBusyAction("new-session");
    setActionError(null);
    const result = await newSession({
      environmentId: activeEnvironmentId,
      input: undefined,
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      handleCommandError(result);
      return;
    }
    setActionNotice(gt("Started a fresh Wagent session."));
  }

  function handleApprovalDecision(approval: WagentPendingApproval, allow: boolean) {
    if (activeEnvironmentId === null || busyAction !== null) return;
    const execute = () => {
      void (async () => {
        setBusyAction(`approval:${approval.id}`);
        setActionError(null);
        setActionNotice(null);
        const result = await decideApproval({
          environmentId: activeEnvironmentId,
          input: { approvalId: approval.id, allow },
        });
        setBusyAction(null);
        if (result._tag === "Failure") {
          handleCommandError(result);
          return;
        }
        setActionNotice(allow ? gt("Deletion command approved.") : gt("Deletion command denied."));
      })();
    };

    if (allow) {
      Dialog.confirm({
        title: gt("Approve destructive command?"),
        message: approval.command,
        confirmText: gt("Approve"),
        destructive: true,
        onConfirm: execute,
      });
    } else {
      execute();
    }
  }

  async function handleImportExport(relativePath: string) {
    if (activeEnvironmentId === null || busyAction !== null) return;
    setBusyAction(`import:${relativePath}`);
    setActionError(null);
    setActionNotice(null);
    const result = await importExport({
      environmentId: activeEnvironmentId,
      input: { relativePath },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      handleCommandError(result);
      return;
    }
    setActionNotice(
      gt("Imported “{title}” into Research Library.", { title: result.value.entry.title }),
    );
  }

  const queryError = liveQuery.error ?? fallbackQuery.error;

  return (
    <SettingsScreen
      title={gt("Wagent")}
      actions={[
        {
          accessibilityLabel: gt("Refresh Wagent"),
          icon: "arrow.clockwise",
          disabled: !enabled,
          onPress: () => {
            liveQuery.refresh();
            fallbackQuery.refresh();
          },
        },
      ]}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 24 }}
      >
        {offline ? (
          <View className="flex-row items-center gap-3 rounded-[18px] border border-border bg-card p-4">
            <SymbolView name="wifi.slash" size={18} tintColorClassName="accent-foreground-muted" />
            <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
              <T>You are offline. Reconnect to monitor Wagent or resolve approvals.</T>
            </Text>
          </View>
        ) : null}

        {selectableEnvironments.length > 1 ||
        (preferredEnvId !== null && connectedEnvironments.length > 0) ? (
          <SettingsSection title={gt("Environment")}>
            <View className="flex-row flex-wrap gap-2 p-3">
              {selectableEnvironments.map((env) => {
                const selected = env.environmentId === (preferredEnvId ?? activeEnvironmentId);
                return (
                  <Pressable
                    key={env.environmentId}
                    accessibilityRole="button"
                    onPress={() => {
                      setActionError(null);
                      setActionNotice(null);
                      setPreferredEnvId(env.environmentId);
                    }}
                    className={
                      selected
                        ? "rounded-full bg-primary px-4 py-2 active:opacity-70"
                        : "rounded-full bg-secondary px-4 py-2 active:opacity-70"
                    }
                  >
                    <Text
                      textRole="footnote"
                      className={
                        selected
                          ? "font-t3-medium text-primary-foreground"
                          : "font-t3-medium text-secondary-foreground"
                      }
                    >
                      {env.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </SettingsSection>
        ) : null}

        {resolution.kind === "disconnected" ? (
          <EmptyState
            title={gt("No environment connected")}
            detail={gt("Connect a host to dispatch tasks to Wagent and approve guarded actions.")}
          />
        ) : resolution.kind === "unsupported" ? (
          <EmptyState
            title={gt("Wagent unavailable on this host")}
            detail={gt(
              "The selected environment ({environment}) does not expose the Wagent domain.",
              { environment: resolution.environment.label },
            )}
          />
        ) : !canRead ? (
          <EmptyState
            title={gt("Permission required")}
            detail={gt("This connection does not have permission to inspect Wagent.")}
          />
        ) : queryError && !status ? (
          <EmptyState
            title={gt("Could not reach Wagent")}
            detail={queryError}
            actionLabel={gt("Retry")}
            onAction={() => {
              liveQuery.refresh();
              fallbackQuery.refresh();
            }}
          />
        ) : !status ? (
          <Text textRole="body" className="px-2 text-foreground-muted">
            <T>Loading Wagent status…</T>
          </Text>
        ) : (
          <>
            {status.pendingApprovals.length > 0 ? (
              <SettingsSection
                title={gt("Pending deletion approvals ({count})", {
                  count: status.pendingApprovals.length,
                })}
              >
                {status.pendingApprovals.map((approval, index) => {
                  const isBusy = busyAction === `approval:${approval.id}`;
                  return (
                    <View
                      key={approval.id}
                      className={
                        index > 0 ? "gap-3 border-t border-border-subtle p-4" : "gap-3 p-4"
                      }
                    >
                      <View className="flex-row items-center gap-2">
                        <SymbolView
                          name="exclamationmark.triangle"
                          size={18}
                          tintColorClassName="accent-danger-foreground"
                        />
                        <Text
                          textRole="body"
                          className="min-w-0 flex-1 font-t3-bold text-danger-foreground"
                        >
                          {approval.reason}
                        </Text>
                      </View>
                      <View className="rounded-xl bg-screen p-3">
                        <Text textRole="footnote" className="font-mono text-foreground" selectable>
                          {approval.command}
                        </Text>
                      </View>
                      <Text textRole="footnote" className="text-foreground-muted">
                        <T>
                          Expires at <Var>{formatShortTime(approval.expiresAt)}</Var>
                        </T>
                      </Text>
                      {canWrite ? (
                        <View className="flex-row flex-wrap gap-2">
                          <Button
                            size="compact"
                            tone="danger"
                            icon="checkmark"
                            label={gt("Approve")}
                            loading={isBusy}
                            disabled={offline || busyAction !== null}
                            onPress={() => handleApprovalDecision(approval, true)}
                          />
                          <Button
                            size="compact"
                            tone="secondary"
                            icon="xmark"
                            label={gt("Deny")}
                            disabled={offline || busyAction !== null}
                            onPress={() => handleApprovalDecision(approval, false)}
                          />
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </SettingsSection>
            ) : null}

            <SettingsSection title={gt("Status")}>
              <View className="gap-1.5 p-4">
                <Text textRole="body" className="font-t3-bold text-foreground">
                  {status.activeRun?.status === "awaiting_approval"
                    ? gt("Awaiting deletion approval")
                    : status.running
                      ? gt("Running task")
                      : gt("Idle")}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  <T>
                    Model: <Var>{status.config.model.provider}</Var>/
                    <Var>{status.config.model.id}</Var>
                  </T>
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {status.telegramConnected
                    ? gt("Telegram bridge: connected")
                    : status.config.telegramEnabled
                      ? gt("Telegram bridge: reconnecting")
                      : gt("Telegram bridge: disabled")}
                </Text>
              </View>
            </SettingsSection>

            {canWrite ? (
              <SettingsSection title={gt("Dispatch task")}>
                <View className="gap-3 p-4">
                  <RNTextInput
                    value={prompt}
                    onChangeText={updatePromptForActiveEnv}
                    placeholder={gt("Ask Wagent to process files, convert media, or query wkb")}
                    placeholderTextColorClassName="accent-foreground-muted"
                    multiline
                    textAlignVertical="top"
                    className="min-h-24 rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                  />
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      size="compact"
                      tone="primary"
                      icon="arrow.up.circle"
                      label={gt("Send")}
                      loading={busyAction === "send"}
                      disabled={offline || prompt.trim().length === 0 || busyAction !== null}
                      onPress={() => void handleSend()}
                    />
                    {status.running ? (
                      <Button
                        size="compact"
                        tone="danger"
                        icon="stop.fill"
                        label={gt("Abort")}
                        loading={busyAction === "abort"}
                        disabled={offline || busyAction !== null}
                        onPress={() => void handleAbort()}
                      />
                    ) : null}
                    <Button
                      size="compact"
                      tone="secondary"
                      label={gt("New session")}
                      loading={busyAction === "new-session"}
                      disabled={offline || busyAction !== null}
                      onPress={() => void handleNewSession()}
                    />
                  </View>
                  {actionError ? (
                    <Text textRole="footnote" className="text-danger-foreground">
                      {actionError}
                    </Text>
                  ) : null}
                  {actionNotice ? (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {actionNotice}
                    </Text>
                  ) : null}
                </View>
              </SettingsSection>
            ) : null}

            {status.activeRun ? (
              <SettingsSection title={gt("Active run")}>
                <View className="gap-2 p-4">
                  <Text textRole="body" className="font-t3-medium text-foreground">
                    {status.activeRun.prompt}
                  </Text>
                  {status.activeRun.steps.slice(-8).map((step) => (
                    <Text
                      key={`${step.timestamp}-${step.kind}-${step.text.slice(0, 32)}`}
                      textRole="footnote"
                      className={
                        step.kind === "error" ? "text-danger-foreground" : "text-foreground-muted"
                      }
                    >
                      {`[${step.kind}] ${step.text}`}
                    </Text>
                  ))}
                </View>
              </SettingsSection>
            ) : null}

            {status.recentRuns.length > 0 ? (
              <SettingsSection title={gt("Recent runs")}>
                {status.recentRuns.slice(0, 5).map((run, index) => (
                  <View
                    key={run.id}
                    className={
                      index > 0 ? "gap-1.5 border-t border-border-subtle p-4" : "gap-1.5 p-4"
                    }
                  >
                    <Text
                      textRole="body"
                      className="font-t3-medium text-foreground"
                      numberOfLines={2}
                    >
                      {run.prompt}
                    </Text>
                    <Text textRole="footnote" className="text-foreground-muted">
                      {gt("{status} · {source} · {time}", {
                        status: run.status,
                        source: run.source,
                        time: formatShortTime(run.updatedAt),
                      })}
                    </Text>
                    {run.error ? (
                      <Text
                        textRole="footnote"
                        className="text-danger-foreground"
                        numberOfLines={3}
                      >
                        {run.error}
                      </Text>
                    ) : run.output.trim().length > 0 ? (
                      <Text textRole="footnote" className="text-foreground-muted" numberOfLines={4}>
                        {run.output.trim()}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </SettingsSection>
            ) : null}

            {status.exports.length > 0 ? (
              <SettingsSection title={gt("Workspace exports")}>
                {status.exports.slice(0, 10).map((file, index) => (
                  <View
                    key={file.relativePath}
                    className={
                      index > 0
                        ? "flex-row items-center gap-3 border-t border-border-subtle p-4"
                        : "flex-row items-center gap-3 p-4"
                    }
                  >
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text
                        textRole="body"
                        className="font-t3-medium text-foreground"
                        numberOfLines={1}
                      >
                        {file.name}
                      </Text>
                      <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
                        {file.relativePath}
                      </Text>
                    </View>
                    {canWrite ? (
                      <Button
                        size="compact"
                        tone="secondary"
                        label={gt("Import")}
                        loading={busyAction === `import:${file.relativePath}`}
                        disabled={offline || busyAction !== null}
                        onPress={() => void handleImportExport(file.relativePath)}
                      />
                    ) : null}
                  </View>
                ))}
              </SettingsSection>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

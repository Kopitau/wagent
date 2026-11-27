import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type LibraryEntrySummary,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
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
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import {
  extractConflictCurrentRevision,
  isLibraryConflictFailure,
  libraryEnvironment,
  resolveMobileLibraryTarget,
  useMobileLibraryEntry,
  useMobileLibraryList,
  useMobileLibraryReadingState,
  useMobileLibraryWritePermission,
} from "../../state/library";
import { ENVIRONMENT_REQUEST_INTERRUPTED } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { createNewTaskDraft, mergeComposerDraftContent } from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

type MobileLibraryRoutes = {
  SettingsLibraryItem: {
    readonly environmentId: EnvironmentId;
    readonly itemId: string;
  };
};

interface QuickCaptureDraft {
  readonly mode: "none" | "note" | "url";
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly note: string;
  readonly tags: string;
}

const EMPTY_CAPTURE_DRAFT: QuickCaptureDraft = {
  mode: "none",
  title: "",
  body: "",
  url: "",
  note: "",
  tags: "",
};

const DEFAULT_DRAFT_QUESTION =
  "Summarize the key takeaways, methodology, and actionable insights from this library entry.";

function parseTagList(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function formatUpdatedLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function MobileLibraryRouteScreen() {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation<NativeStackNavigationProp<MobileLibraryRoutes>>();
  const insets = useSafeAreaInsets();
  const { environments, networkStatus } = useEnvironments();

  const [preferredEnvId, setPreferredEnvId] = useState<EnvironmentId | null>(null);
  const [searchQueriesByEnv, setSearchQueriesByEnv] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [captureDraftsByEnv, setCaptureDraftsByEnv] = useState<
    Readonly<Record<string, QuickCaptureDraft>>
  >({});
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);

  const connectedEnvironments = environments.filter(
    (entry) => entry.connection.phase === "connected" && entry.serverConfig !== null,
  );
  const selectableEnvironments = environments.filter(
    (entry) =>
      (entry.connection.phase === "connected" && entry.serverConfig !== null) ||
      entry.environmentId === preferredEnvId,
  );
  const resolution = resolveMobileLibraryTarget(environments, preferredEnvId);
  const activeEnvironment = resolution.kind === "ready" ? resolution.environment : null;
  const activeEnvironmentId = activeEnvironment?.environmentId ?? null;

  const activeSearchQuery =
    activeEnvironmentId !== null ? (searchQueriesByEnv[activeEnvironmentId] ?? "") : "";
  const activeCaptureDraft =
    activeEnvironmentId !== null
      ? (captureDraftsByEnv[activeEnvironmentId] ?? EMPTY_CAPTURE_DRAFT)
      : EMPTY_CAPTURE_DRAFT;

  function patchActiveCaptureDraft(patch: Partial<QuickCaptureDraft>) {
    if (activeEnvironmentId === null) return;
    if (preferredEnvId === null) {
      setPreferredEnvId(activeEnvironmentId);
    }
    setCaptureDraftsByEnv((prev) => {
      const current = prev[activeEnvironmentId] ?? EMPTY_CAPTURE_DRAFT;
      return {
        ...prev,
        [activeEnvironmentId]: {
          ...current,
          ...patch,
        },
      };
    });
  }

  const canRead = useEnvironmentScope(activeEnvironmentId, AuthOrchestrationReadScope);
  const canWrite = useMobileLibraryWritePermission(activeEnvironmentId);
  const queryEnabled = activeEnvironmentId !== null && canRead;

  const listQuery = useMobileLibraryList(
    activeEnvironmentId,
    {
      query: activeSearchQuery.trim().length > 0 ? activeSearchQuery.trim() : undefined,
      limit: 50,
    },
    queryEnabled,
  );

  const saveEntry = useAtomCommand(libraryEnvironment.save, {
    label: "mobile library save",
    reportFailure: false,
  });
  const fetchUrl = useAtomCommand(libraryEnvironment.fetchUrl, {
    label: "mobile library fetch url",
    reportFailure: false,
  });

  const offline = networkStatus === "offline";

  async function handleSaveNote() {
    if (activeEnvironmentId === null || captureBusy) return;
    const targetEnvironmentId = activeEnvironmentId;
    const draft = captureDraftsByEnv[targetEnvironmentId] ?? EMPTY_CAPTURE_DRAFT;
    const title = draft.title.trim();
    if (title.length === 0) {
      setCaptureError(gt("Enter a title before saving."));
      return;
    }
    setPreferredEnvId(targetEnvironmentId);
    setCaptureBusy(true);
    setCaptureError(null);
    setCaptureNotice(null);
    const result = await saveEntry({
      environmentId: targetEnvironmentId,
      input: {
        kind: "note",
        title,
        body: draft.body,
        note: draft.note,
        tags: parseTagList(draft.tags),
      },
    });
    setCaptureBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        setCaptureError(messages(ENVIRONMENT_REQUEST_INTERRUPTED));
        return;
      }
      const failure = squashAtomCommandFailure(result);
      setCaptureError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, messages) ?? failure.message)
          : gt("Could not save note. Check your connection and try again."),
      );
      return;
    }
    setCaptureDraftsByEnv((prev) => ({ ...prev, [targetEnvironmentId]: EMPTY_CAPTURE_DRAFT }));
    setCaptureNotice(gt("Saved to Research Library."));
  }

  async function handleSaveUrl() {
    if (activeEnvironmentId === null || captureBusy) return;
    const targetEnvironmentId = activeEnvironmentId;
    const draft = captureDraftsByEnv[targetEnvironmentId] ?? EMPTY_CAPTURE_DRAFT;
    const url = draft.url.trim();
    if (url.length === 0) {
      setCaptureError(gt("Enter a URL to fetch."));
      return;
    }
    setPreferredEnvId(targetEnvironmentId);
    setCaptureBusy(true);
    setCaptureError(null);
    setCaptureNotice(null);
    const result = await fetchUrl({
      environmentId: targetEnvironmentId,
      input: {
        url,
        title: draft.title.trim().length > 0 ? draft.title.trim() : undefined,
        note: draft.note.trim().length > 0 ? draft.note : undefined,
        tags: parseTagList(draft.tags),
        allowFallback: true,
      },
    });
    setCaptureBusy(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        setCaptureError(messages(ENVIRONMENT_REQUEST_INTERRUPTED));
        return;
      }
      const failure = squashAtomCommandFailure(result);
      setCaptureError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, messages) ?? failure.message)
          : gt("Could not fetch URL. Check your connection and try again."),
      );
      return;
    }
    setCaptureDraftsByEnv((prev) => ({ ...prev, [targetEnvironmentId]: EMPTY_CAPTURE_DRAFT }));
    setCaptureNotice(
      result.value.fetched
        ? gt("Web article saved to Research Library.")
        : gt("Saved URL bookmark to Research Library."),
    );
  }

  const items: ReadonlyArray<LibraryEntrySummary> = listQuery.data?.items ?? [];

  return (
    <SettingsScreen
      title={gt("Library")}
      actions={[
        {
          accessibilityLabel: gt("Refresh library"),
          icon: "arrow.clockwise",
          disabled: !queryEnabled,
          onPress: () => listQuery.refresh(),
        },
      ]}
      search={
        queryEnabled
          ? {
              value: activeSearchQuery,
              onChangeText: (nextQuery) => {
                if (activeEnvironmentId === null) return;
                if (preferredEnvId === null) {
                  setPreferredEnvId(activeEnvironmentId);
                }
                setSearchQueriesByEnv((prev) => ({
                  ...prev,
                  [activeEnvironmentId]: nextQuery,
                }));
              },
              placeholder: gt("Search papers, notes, tags"),
            }
          : undefined
      }
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
              <T>You appear to be offline. Reconnect to load or edit your library.</T>
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
                      setCaptureError(null);
                      setCaptureNotice(null);
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
            detail={gt("Connect a host running T3 Code to browse and edit your Research Library.")}
          />
        ) : resolution.kind === "unsupported" ? (
          <EmptyState
            title={gt("Library unavailable on this host")}
            detail={gt(
              "The selected environment ({environment}) does not expose the Research Library capability.",
              { environment: resolution.environment.label },
            )}
          />
        ) : !canRead ? (
          <EmptyState
            title={gt("Permission required")}
            detail={gt("This connection does not have permission to read the Research Library.")}
          />
        ) : (
          <>
            {canWrite ? (
              <SettingsSection title={gt("Quick capture")}>
                <View className="gap-3 p-4">
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      size="compact"
                      tone={activeCaptureDraft.mode === "note" ? "primary" : "secondary"}
                      icon="plus"
                      label={gt("Add note")}
                      onPress={() => {
                        setCaptureError(null);
                        patchActiveCaptureDraft({
                          mode: activeCaptureDraft.mode === "note" ? "none" : "note",
                        });
                      }}
                    />
                    <Button
                      size="compact"
                      tone={activeCaptureDraft.mode === "url" ? "primary" : "secondary"}
                      icon="link"
                      label={gt("Save URL")}
                      onPress={() => {
                        setCaptureError(null);
                        patchActiveCaptureDraft({
                          mode: activeCaptureDraft.mode === "url" ? "none" : "url",
                        });
                      }}
                    />
                  </View>

                  {activeCaptureDraft.mode === "note" ? (
                    <View className="gap-3 pt-1">
                      <RNTextInput
                        value={activeCaptureDraft.title}
                        onChangeText={(title) => patchActiveCaptureDraft({ title })}
                        placeholder={gt("Title")}
                        placeholderTextColorClassName="accent-foreground-muted"
                        className="rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                      />
                      <RNTextInput
                        value={activeCaptureDraft.body}
                        onChangeText={(body) => patchActiveCaptureDraft({ body })}
                        placeholder={gt("Content or excerpt")}
                        placeholderTextColorClassName="accent-foreground-muted"
                        multiline
                        textAlignVertical="top"
                        className="min-h-24 rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                      />
                      <RNTextInput
                        value={activeCaptureDraft.note}
                        onChangeText={(note) => patchActiveCaptureDraft({ note })}
                        placeholder={gt("Personal reading note (optional)")}
                        placeholderTextColorClassName="accent-foreground-muted"
                        multiline
                        textAlignVertical="top"
                        className="min-h-16 rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                      />
                      <RNTextInput
                        value={activeCaptureDraft.tags}
                        onChangeText={(tags) => patchActiveCaptureDraft({ tags })}
                        placeholder={gt("Tags, comma-separated")}
                        placeholderTextColorClassName="accent-foreground-muted"
                        className="rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                      />
                      <Button
                        tone="primary"
                        label={gt("Save note")}
                        loading={captureBusy}
                        disabled={offline}
                        onPress={() => void handleSaveNote()}
                      />
                    </View>
                  ) : null}

                  {activeCaptureDraft.mode === "url" ? (
                    <View className="gap-3 pt-1">
                      <RNTextInput
                        value={activeCaptureDraft.url}
                        onChangeText={(url) => patchActiveCaptureDraft({ url })}
                        placeholder="https://arxiv.org/abs/..."
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        placeholderTextColorClassName="accent-foreground-muted"
                        className="rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                      />
                      <RNTextInput
                        value={activeCaptureDraft.title}
                        onChangeText={(title) => patchActiveCaptureDraft({ title })}
                        placeholder={gt("Optional custom title")}
                        placeholderTextColorClassName="accent-foreground-muted"
                        className="rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                      />
                      <RNTextInput
                        value={activeCaptureDraft.note}
                        onChangeText={(note) => patchActiveCaptureDraft({ note })}
                        placeholder={gt("Personal note (optional)")}
                        placeholderTextColorClassName="accent-foreground-muted"
                        multiline
                        textAlignVertical="top"
                        className="min-h-16 rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                      />
                      <RNTextInput
                        value={activeCaptureDraft.tags}
                        onChangeText={(tags) => patchActiveCaptureDraft({ tags })}
                        placeholder={gt("Tags, comma-separated")}
                        placeholderTextColorClassName="accent-foreground-muted"
                        className="rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                      />
                      <Button
                        tone="primary"
                        label={gt("Fetch and save")}
                        loading={captureBusy}
                        disabled={offline}
                        onPress={() => void handleSaveUrl()}
                      />
                    </View>
                  ) : null}

                  {captureError ? (
                    <Text textRole="footnote" className="text-danger-foreground">
                      {captureError}
                    </Text>
                  ) : null}
                  {captureNotice ? (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {captureNotice}
                    </Text>
                  ) : null}
                </View>
              </SettingsSection>
            ) : null}

            {listQuery.error ? (
              <EmptyState
                title={gt("Could not load library")}
                detail={listQuery.error}
                actionLabel={gt("Retry")}
                onAction={() => listQuery.refresh()}
              />
            ) : items.length === 0 && !listQuery.isPending ? (
              <EmptyState
                title={
                  activeSearchQuery.trim().length > 0
                    ? gt("No matching entries")
                    : gt("Library is empty")
                }
                detail={
                  activeSearchQuery.trim().length > 0
                    ? gt("Try a different search keyword or clear the query.")
                    : gt("Capture a note or web article above, or upload PDFs on desktop.")
                }
              />
            ) : (
              <SettingsSection
                title={gt("Entries ({count})", { count: listQuery.data?.total ?? items.length })}
              >
                {items.map((item, index) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    onPress={() =>
                      navigation.navigate("SettingsLibraryItem", {
                        environmentId: resolution.environment.environmentId,
                        itemId: item.id,
                      })
                    }
                    className={
                      index > 0
                        ? "flex-row items-center gap-3 border-t border-border-subtle px-4 py-3.5 active:opacity-70"
                        : "flex-row items-center gap-3 px-4 py-3.5 active:opacity-70"
                    }
                  >
                    <View className="min-w-0 flex-1 gap-1">
                      <Text
                        textRole="body"
                        className="font-t3-medium text-foreground"
                        numberOfLines={2}
                      >
                        {item.title}
                      </Text>
                      <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
                        {item.pageCount > 0
                          ? gt("{kind} · {pages} pages · {date}", {
                              kind: item.kind.toUpperCase(),
                              pages: item.pageCount,
                              date: formatUpdatedLabel(item.updatedAt),
                            })
                          : gt("{kind} · {date}", {
                              kind: item.kind.toUpperCase(),
                              date: formatUpdatedLabel(item.updatedAt),
                            })}
                      </Text>
                      {item.notePreview.trim().length > 0 || item.snippet.trim().length > 0 ? (
                        <Text
                          textRole="footnote"
                          className="text-foreground-muted"
                          numberOfLines={2}
                        >
                          {item.notePreview.trim().length > 0 ? item.notePreview : item.snippet}
                        </Text>
                      ) : null}
                      {item.tags.length > 0 ? (
                        <Text textRole="footnote" className="text-primary-text" numberOfLines={1}>
                          {item.tags.map((tag) => `#${tag}`).join(" ")}
                        </Text>
                      ) : null}
                    </View>
                    <SymbolView
                      name="chevron.right"
                      size={14}
                      tintColorClassName="accent-chevron"
                      type="monochrome"
                    />
                  </Pressable>
                ))}
              </SettingsSection>
            )}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

export function MobileLibraryItemRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly itemId: string;
}>) {
  return (
    <MobileLibraryItemDetail
      key={`${route.params.environmentId}:${route.params.itemId}`}
      environmentId={route.params.environmentId}
      itemId={route.params.itemId}
    />
  );
}

function MobileLibraryItemDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly itemId: string;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation<NativeStackNavigationProp<MobileLibraryRoutes>>();
  const selectDetail = useSelectWorkspaceDetail();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const { networkStatus } = useEnvironments();

  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const canWrite = useMobileLibraryWritePermission(props.environmentId);

  const entryQuery = useMobileLibraryEntry(props.environmentId, props.itemId, canRead);
  const readingQuery = useMobileLibraryReadingState(props.environmentId, props.itemId, canRead);

  const updateEntry = useAtomCommand(libraryEnvironment.update, {
    label: "mobile library update note",
    reportFailure: false,
  });
  const deleteEntry = useAtomCommand(libraryEnvironment.delete, {
    label: "mobile library delete entry",
    reportFailure: false,
  });
  const composeDraft = useAtomCommand(libraryEnvironment.composeDraft, {
    label: "mobile library compose draft",
    reportFailure: false,
  });
  const openScratch = useAtomCommand(projectEnvironment.openScratch, {
    label: "mobile library open scratch",
    reportFailure: false,
  });

  const envProjects = projects.filter((project) => project.environmentId === props.environmentId);
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const selectedEnvProject =
    envProjects.find((project) => project.id === selectedProjectId) ?? envProjects[0] ?? null;

  const entry = entryQuery.data?.entry ?? null;
  const readingState = readingQuery.data;

  // Draft tracks the exact revision where editing started so concurrent edits
  // trigger LibraryEditConflictError instead of silently overwriting desktop notes.
  const [noteDraft, setNoteDraft] = useState<{
    readonly baseRevision: number;
    readonly text: string;
  } | null>(null);
  const [conflictState, setConflictState] = useState<{
    readonly currentRevision: number | null;
    readonly message: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const offline = networkStatus === "offline";
  const noteValue = noteDraft !== null ? noteDraft.text : (entry?.note ?? "");
  const expectedRevision = noteDraft !== null ? noteDraft.baseRevision : (entry?.revision ?? 1);
  const isDirty = entry !== null && noteDraft !== null && noteDraft.text !== entry.note;

  // Require the refreshed server revision to be visible on screen before allowing conflict overwrite.
  const conflictLatestVisible =
    conflictState !== null &&
    !entryQuery.isPending &&
    entry !== null &&
    (conflictState.currentRevision === null || entry.revision >= conflictState.currentRevision);

  async function saveNoteWithRevision(targetRevision: number) {
    if (!entry || saving) return;
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    const result = await updateEntry({
      environmentId: props.environmentId,
      input: {
        id: entry.id,
        expectedRevision: targetRevision,
        note: noteValue,
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) {
        setSaveError(messages(ENVIRONMENT_REQUEST_INTERRUPTED));
        return;
      }
      const failure = squashAtomCommandFailure(result);
      if (isLibraryConflictFailure(failure)) {
        const latestRev = extractConflictCurrentRevision(failure);
        setConflictState({
          currentRevision: latestRev,
          message: gt(
            "This entry was updated elsewhere while you were editing. Reload the latest version or review before saving over it.",
          ),
        });
        entryQuery.refresh();
        return;
      }
      setSaveError(
        failure instanceof Error
          ? (errorDisplayMessage(failure, messages) ?? failure.message)
          : gt("Could not save note. Your local draft is preserved."),
      );
      return;
    }
    setConflictState(null);
    setNoteDraft(null);
    setSaveNotice(gt("Note saved (rev {revision}).", { revision: result.value.revision }));
  }

  async function handleSendToNewTask() {
    if (!entry || draftBusy) return;
    setDraftBusy(true);
    setSaveError(null);
    const question = draftQuestion.trim() || DEFAULT_DRAFT_QUESTION;
    const result = await composeDraft({
      environmentId: props.environmentId,
      input: {
        entryIds: [entry.id],
        question,
      },
    });
    if (result._tag === "Failure") {
      setDraftBusy(false);
      const failure = squashAtomCommandFailure(result);
      setSaveError(
        isAtomCommandInterrupted(result)
          ? messages(ENVIRONMENT_REQUEST_INTERRUPTED)
          : failure instanceof Error
            ? (errorDisplayMessage(failure, messages) ?? failure.message)
            : gt("Could not compose task prompt."),
      );
      return;
    }

    try {
      let targetProjectId: ProjectId | null = selectedEnvProject?.id ?? null;
      if (targetProjectId === null) {
        const scratchResult = await openScratch({
          environmentId: props.environmentId,
          input: {},
        });
        if (scratchResult._tag === "Failure") {
          setDraftBusy(false);
          const failure = squashAtomCommandFailure(scratchResult);
          setSaveError(
            isAtomCommandInterrupted(scratchResult)
              ? messages(ENVIRONMENT_REQUEST_INTERRUPTED)
              : failure instanceof Error
                ? (errorDisplayMessage(failure, messages) ?? failure.message)
                : gt("No project available in this environment."),
          );
          return;
        }
        targetProjectId = scratchResult.value.id;
      }

      const draftKey = createNewTaskDraft({
        environmentId: props.environmentId,
        projectId: targetProjectId,
      });
      await mergeComposerDraftContent(draftKey, {
        text: result.value.prompt,
        attachments: [],
      });
      setDraftBusy(false);
      selectDetail({
        name: "Thread",
        params: {
          draft: {
            environmentId: String(props.environmentId),
            projectId: String(targetProjectId),
            draftId: draftKey,
          },
        },
      });
    } catch {
      setDraftBusy(false);
      setSaveError(gt("Could not prepare new task draft."));
    }
  }

  function handleDeleteConfirm() {
    if (!entry || deleting) return;
    Dialog.confirm({
      title: gt("Delete library entry?"),
      message: gt("Remove “{title}” from this environment's Research Library.", {
        title: entry.title,
      }),
      confirmText: gt("Delete"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          setDeleting(true);
          const result = await deleteEntry({
            environmentId: props.environmentId,
            input: {
              id: entry.id,
              expectedRevision: entry.revision,
            },
          });
          setDeleting(false);
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            setSaveError(
              isLibraryConflictFailure(failure)
                ? gt("Entry changed on another device. Refresh before deleting.")
                : failure instanceof Error
                  ? (errorDisplayMessage(failure, messages) ?? failure.message)
                  : gt("Could not delete entry."),
            );
            return;
          }
          if (navigation.canGoBack()) navigation.goBack();
        })();
      },
    });
  }

  const annotatedParagraphs =
    readingState?.paragraphs.filter(
      (paragraph) => paragraph.marked || paragraph.highlighted || paragraph.note.trim().length > 0,
    ) ?? [];
  const questions = readingState?.questions ?? [];

  return (
    <SettingsScreen
      title={entry?.title ?? gt("Library entry")}
      actions={[
        {
          accessibilityLabel: gt("Refresh entry"),
          icon: "arrow.clockwise",
          onPress: () => {
            entryQuery.refresh();
            readingQuery.refresh();
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
              <T>Offline. Any unsaved note edits stay on screen until you reconnect.</T>
            </Text>
          </View>
        ) : null}

        {entryQuery.error && !entry ? (
          <EmptyState
            title={gt("Could not load entry")}
            detail={entryQuery.error}
            actionLabel={gt("Retry")}
            onAction={() => entryQuery.refresh()}
          />
        ) : !entry ? (
          <Text textRole="body" className="px-2 text-foreground-muted">
            <T>Loading entry…</T>
          </Text>
        ) : (
          <>
            <SettingsSection title={gt("Overview")}>
              <View className="gap-2 p-4">
                <Text textRole="headline" className="font-t3-bold text-foreground" selectable>
                  {entry.title}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {entry.pageCount > 0
                    ? gt("{kind} · {pages} pages · rev {revision}", {
                        kind: entry.kind.toUpperCase(),
                        pages: entry.pageCount,
                        revision: entry.revision,
                      })
                    : gt("{kind} · rev {revision}", {
                        kind: entry.kind.toUpperCase(),
                        revision: entry.revision,
                      })}
                </Text>
                {entry.tags.length > 0 ? (
                  <Text textRole="footnote" className="text-primary-text">
                    {entry.tags.map((tag) => `#${tag}`).join(" ")}
                  </Text>
                ) : null}
                {entry.url ? (
                  <Pressable
                    accessibilityRole="link"
                    onPress={() => void tryOpenExternalUrl(entry.url!)}
                    className="flex-row items-center gap-1.5 pt-1 active:opacity-70"
                  >
                    <SymbolView
                      name="arrow.up.right"
                      size={14}
                      tintColorClassName="accent-primary-text"
                    />
                    <Text
                      textRole="footnote"
                      className="min-w-0 flex-1 text-primary-text"
                      numberOfLines={1}
                    >
                      {entry.url}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </SettingsSection>

            {conflictState ? (
              <View className="gap-3 rounded-[20px] border border-danger-foreground bg-card p-4">
                <View className="flex-row items-center gap-2">
                  <SymbolView
                    name="exclamationmark.triangle"
                    size={18}
                    tintColorClassName="accent-danger-foreground"
                  />
                  <Text textRole="body" className="font-t3-bold text-danger-foreground">
                    <T>Edit conflict detected</T>
                  </Text>
                </View>
                <Text textRole="footnote" className="text-foreground">
                  {conflictState.message}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted" selectable>
                  {conflictLatestVisible ? (
                    <T>
                      Server latest note: <Var>{entry.note || gt("(empty)")}</Var>
                    </T>
                  ) : (
                    <T>Loading latest server revision before enabling overwrite…</T>
                  )}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  <Button
                    size="compact"
                    tone="secondary"
                    label={gt("Reload latest")}
                    onPress={() => {
                      setConflictState(null);
                      setNoteDraft(null);
                      setSaveError(null);
                      entryQuery.refresh();
                    }}
                  />
                  <Button
                    size="compact"
                    tone="danger"
                    label={gt("Save my draft over latest")}
                    loading={saving}
                    disabled={!canWrite || offline || !conflictLatestVisible}
                    onPress={() => {
                      void saveNoteWithRevision(entry.revision);
                    }}
                  />
                </View>
              </View>
            ) : null}

            <SettingsSection title={gt("Personal note")}>
              <View className="gap-3 p-4">
                <RNTextInput
                  value={noteValue}
                  readOnly={!canWrite || saving}
                  onChangeText={(nextText) => {
                    setSaveNotice(null);
                    setSaveError(null);
                    setNoteDraft((prev) => ({
                      baseRevision: prev?.baseRevision ?? entry.revision,
                      text: nextText,
                    }));
                  }}
                  placeholder={gt("Write reading takeaways or open questions")}
                  placeholderTextColorClassName="accent-foreground-muted"
                  multiline
                  textAlignVertical="top"
                  className="min-h-28 rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                />
                {saveError ? (
                  <Text textRole="footnote" className="text-danger-foreground">
                    {saveError}
                  </Text>
                ) : null}
                {saveNotice ? (
                  <Text textRole="footnote" className="text-foreground-muted">
                    {saveNotice}
                  </Text>
                ) : null}
                {canWrite ? (
                  <View className="flex-row flex-wrap gap-2">
                    <Button
                      size="compact"
                      tone="primary"
                      label={gt("Save note")}
                      loading={saving}
                      disabled={!isDirty || offline}
                      onPress={() => void saveNoteWithRevision(expectedRevision)}
                    />
                    {isDirty ? (
                      <Button
                        size="compact"
                        tone="secondary"
                        label={gt("Revert")}
                        disabled={saving}
                        onPress={() => {
                          setNoteDraft(null);
                          setConflictState(null);
                          setSaveError(null);
                        }}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            </SettingsSection>

            <SettingsSection title={gt("Send to new task")}>
              <View className="gap-3 p-4">
                {envProjects.length > 1 ? (
                  <View className="flex-row flex-wrap gap-2">
                    {envProjects.map((project) => {
                      const active = project.id === selectedEnvProject?.id;
                      return (
                        <Pressable
                          key={project.id}
                          accessibilityRole="button"
                          onPress={() => setSelectedProjectId(project.id)}
                          className={
                            active
                              ? "rounded-full bg-primary px-3.5 py-1.5 active:opacity-70"
                              : "rounded-full bg-secondary px-3.5 py-1.5 active:opacity-70"
                          }
                        >
                          <Text
                            textRole="footnote"
                            className={
                              active
                                ? "font-t3-medium text-primary-foreground"
                                : "font-t3-medium text-secondary-foreground"
                            }
                          >
                            {project.title}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                <RNTextInput
                  value={draftQuestion}
                  onChangeText={setDraftQuestion}
                  placeholder={gt("Ask an agent about this paper or note (optional)")}
                  placeholderTextColorClassName="accent-foreground-muted"
                  multiline
                  textAlignVertical="top"
                  className="min-h-16 rounded-xl border border-border-subtle bg-screen px-3 py-2.5 font-sans text-base text-foreground"
                />
                <Button
                  size="compact"
                  tone="primary"
                  icon="plus.bubble"
                  label={gt("Compose new task")}
                  loading={draftBusy}
                  disabled={offline}
                  onPress={() => void handleSendToNewTask()}
                />
              </View>
            </SettingsSection>

            {annotatedParagraphs.length > 0 ? (
              <SettingsSection
                title={gt("Reading annotations ({count})", { count: annotatedParagraphs.length })}
              >
                {annotatedParagraphs.slice(0, 20).map((paragraph, index) => (
                  <View
                    key={`${paragraph.physicalPage}:${paragraph.anchor}`}
                    className={
                      index > 0 ? "gap-1.5 border-t border-border-subtle p-4" : "gap-1.5 p-4"
                    }
                  >
                    <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                      <T>
                        Page <Var>{paragraph.physicalPage}</Var> ·{" "}
                        <Var>{paragraph.wkbKind || "note"}</Var>
                      </T>
                    </Text>
                    {paragraph.quote.trim().length > 0 ? (
                      <Text textRole="footnote" className="text-foreground" selectable>
                        {paragraph.quote}
                      </Text>
                    ) : null}
                    {paragraph.note.trim().length > 0 ? (
                      <Text textRole="footnote" className="text-primary-text" selectable>
                        {paragraph.note}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </SettingsSection>
            ) : null}

            {questions.length > 0 ? (
              <SettingsSection title={gt("Muddiest points ({count})", { count: questions.length })}>
                {questions.slice(0, 15).map((item, index) => (
                  <View
                    key={item.id}
                    className={
                      index > 0 ? "gap-1.5 border-t border-border-subtle p-4" : "gap-1.5 p-4"
                    }
                  >
                    <Text textRole="body" className="font-t3-medium text-foreground" selectable>
                      {item.question}
                    </Text>
                    {item.selfAnswer.trim().length > 0 ? (
                      <Text textRole="footnote" className="text-foreground-muted" selectable>
                        <T>
                          My thought: <Var>{item.selfAnswer}</Var>
                        </T>
                      </Text>
                    ) : null}
                    {item.answer.trim().length > 0 ? (
                      <Text textRole="footnote" className="text-foreground" selectable>
                        {item.answer}
                      </Text>
                    ) : null}
                  </View>
                ))}
              </SettingsSection>
            ) : null}

            {entry.body.trim().length > 0 ? (
              <SettingsSection title={gt("Excerpt")}>
                <View className="p-4">
                  <Text textRole="footnote" className="text-foreground" selectable>
                    {entry.body.length > 4000 ? `${entry.body.slice(0, 4000)}...` : entry.body}
                  </Text>
                </View>
              </SettingsSection>
            ) : null}

            {canWrite ? (
              <View className="pt-1">
                <Button
                  tone="danger"
                  icon="trash"
                  label={gt("Delete entry")}
                  loading={deleting}
                  disabled={offline}
                  onPress={handleDeleteConfirm}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

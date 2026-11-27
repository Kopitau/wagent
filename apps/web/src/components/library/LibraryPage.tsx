import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isLibraryEditConflictError,
  type EnvironmentId,
  type LibraryDeleteInput,
  type LibraryEntry,
  type LibraryEntryKind,
  type LibraryEntrySummary,
  type LibraryListInput,
  type LibrarySaveInput,
  type LibraryUpdateInput,
  type ProjectId,
} from "@t3tools/contracts";
import { LIBRARY_MAX_DRAFT_ITEMS } from "@t3tools/research-library";
import { msg, Plural, T, useGT, useMessages, Var } from "gt-react";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FileUpIcon,
  GlobeIcon,
  LockIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  SearchIcon,
  StickyNoteIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
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
  EmptyContent,
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
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { m } from "~/i18n/messages";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { libraryEnvironment, useLibraryEntry, useLibraryList } from "~/state/library";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  formatLibraryUrlHost,
  formatTagsInput,
  isLinkEntryKind,
  parseTagsInput,
  readUtf8TextImportFile,
  resolveActiveLibraryEnvironmentId,
  toggleDraftSelection,
} from "./libraryFormatting.logic";

const PAGE_SIZE = 20;
const ALL_KINDS_VALUE = "all";

const KIND_LABELS = {
  note: msg("Note", { $context: "research library entry kind" }),
  web: msg("Web link", { $context: "research library entry kind" }),
  wechat: msg("WeChat article", { $context: "research library entry kind" }),
  file: msg("Text file", { $context: "research library entry kind" }),
  pdf: msg("PDF", { $context: "research library entry kind" }),
} as const;

const CREATE_KINDS = ["note", "web", "wechat"] as const satisfies ReadonlyArray<LibraryEntryKind>;
const FILTER_KINDS = [
  "note",
  "web",
  "wechat",
  "file",
  "pdf",
] as const satisfies ReadonlyArray<LibraryEntryKind>;

interface ConflictState {
  readonly expectedRevision: number;
  readonly currentRevision: number;
}

function commandFailureText(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    return errorDisplayMessage(cause, m) ?? (cause.message || fallback);
  }
  return fallback;
}

function EntryKindIcon({ kind }: { readonly kind: LibraryEntryKind }) {
  switch (kind) {
    case "web":
    case "wechat":
      return <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    case "file":
    case "pdf":
      return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    case "note":
      return <StickyNoteIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function LibraryCreateDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: LibrarySaveInput) => Promise<string | null>;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const [kind, setKind] = useState<LibraryEntryKind>("note");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setKind("note");
    setTitle("");
    setUrl("");
    setTagsText("");
    setBody("");
    setNote("");
    setError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  };

  const handleSave = async () => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    const trimmedUrl = url.trim();
    const tags = parseTagsInput(tagsText);
    const failure = await onSubmit({
      kind,
      title: title.trim(),
      ...(trimmedUrl.length > 0 ? { url: trimmedUrl } : {}),
      body,
      note,
      ...(tags.length > 0 ? { tags: [...tags] } : {}),
    });
    setSubmitting(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    resetForm();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>Save to library</T>
          </DialogTitle>
          <DialogDescription>
            <T>Create a standalone note or save a link with manual excerpts and notes.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="library-create-kind">
                <T>Entry type</T>
              </Label>
              <Select
                value={kind}
                onValueChange={(next) => {
                  if (next) setKind(next as LibraryEntryKind);
                }}
              >
                <SelectTrigger id="library-create-kind">
                  <SelectValue>{resolveMessage(KIND_LABELS[kind])}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {CREATE_KINDS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {resolveMessage(KIND_LABELS[option])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="library-create-title">
                <T>Title</T>
              </Label>
              <Input
                id="library-create-title"
                placeholder={gt("Paper title, article headline, or note name")}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            {isLinkEntryKind(kind) ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="library-create-url">
                  <T>Source URL</T>
                </Label>
                <Input
                  id="library-create-url"
                  type="url"
                  placeholder={gt("https://example.com/article")}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="library-create-tags">
                <T>Tags</T>
              </Label>
              <Input
                id="library-create-tags"
                placeholder={gt("Comma-separated tags, e.g. agents, reading")}
                value={tagsText}
                onChange={(event) => setTagsText(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="library-create-body">
                {isLinkEntryKind(kind) ? <T>Manual excerpt</T> : <T>Content</T>}
              </Label>
              <Textarea
                id="library-create-body"
                rows={5}
                placeholder={gt("Paste key passages, markdown, or text")}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="library-create-note">
                <T>Personal note</T>
              </Label>
              <Textarea
                id="library-create-note"
                rows={3}
                placeholder={gt("Why this matters or questions to follow up on")}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            {error ? (
              <Alert variant="error">
                <AlertTriangleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </DialogClose>
          <Button
            disabled={
              submitting ||
              title.trim().length === 0 ||
              (isLinkEntryKind(kind) && url.trim().length === 0)
            }
            onClick={() => void handleSave()}
          >
            {submitting ? <Spinner className="size-3.5" /> : null}
            <T>Save entry</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function LibraryEntryEditor({
  entry,
  canWrite,
  onSave,
  onDelete,
  onReload,
}: {
  readonly entry: LibraryEntry;
  readonly canWrite: boolean;
  readonly onSave: (
    input: LibraryUpdateInput,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly conflict?: ConflictState; readonly message: string }
  >;
  readonly onDelete: (
    input: LibraryDeleteInput,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly conflict?: ConflictState; readonly message: string }
  >;
  readonly onReload: () => void;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const [title, setTitle] = useState(entry.title);
  const [url, setUrl] = useState(entry.url ?? "");
  const [tagsText, setTagsText] = useState(formatTagsInput(entry.tags));
  const [body, setBody] = useState(entry.body);
  const [note, setNote] = useState(entry.note);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsedTags = parseTagsInput(tagsText);
  const isDirty =
    title !== entry.title ||
    url !== (entry.url ?? "") ||
    tagsText !== formatTagsInput(entry.tags) ||
    body !== entry.body ||
    note !== entry.note;

  const handleSave = async () => {
    if (!canWrite || saving) return;
    setError(null);
    setConflict(null);
    setSaving(true);
    const trimmedUrl = url.trim();
    const outcome = await onSave({
      id: entry.id,
      expectedRevision: entry.revision,
      title: title.trim(),
      url: trimmedUrl.length > 0 ? trimmedUrl : null,
      tags: [...parsedTags],
      body,
      note,
    });
    setSaving(false);
    if (!outcome.ok) {
      if (outcome.conflict) {
        setConflict(outcome.conflict);
      } else {
        setError(outcome.message);
      }
    }
  };

  const handleConfirmDelete = async () => {
    if (!canWrite || deleting) return;
    setError(null);
    setConflict(null);
    setDeleting(true);
    const outcome = await onDelete({
      id: entry.id,
      expectedRevision: entry.revision,
    });
    setDeleting(false);
    setConfirmDeleteOpen(false);
    if (!outcome.ok) {
      if (outcome.conflict) {
        setConflict(outcome.conflict);
      } else {
        setError(outcome.message);
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">{resolveMessage(KIND_LABELS[entry.kind])}</Badge>
          <span className="text-muted-foreground text-xs">
            <T>
              Revision <Var>{entry.revision}</Var>
            </T>
          </span>
          {entry.pageCount > 0 ? (
            <span className="text-muted-foreground text-xs">
              <Plural
                n={entry.pageCount}
                one={
                  <>
                    <Var>{entry.pageCount}</Var> page
                  </>
                }
                other={
                  <>
                    <Var>{entry.pageCount}</Var> pages
                  </>
                }
              />
            </span>
          ) : null}
          {entry.url ? (
            <a
              className="inline-flex items-center gap-1 truncate text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
              href={entry.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span>{formatLibraryUrlHost(entry.url) ?? entry.url}</span>
              <ExternalLinkIcon className="size-3 shrink-0" />
            </a>
          ) : null}
        </div>
        {canWrite ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={deleting}
              onClick={() => setConfirmDeleteOpen(true)}
            >
              <Trash2Icon />
              <T>Delete</T>
            </Button>
            <Button
              size="sm"
              disabled={saving || !isDirty || title.trim().length === 0}
              onClick={() => void handleSave()}
            >
              {saving ? <Spinner className="size-3.5" /> : null}
              <T>Save changes</T>
            </Button>
          </div>
        ) : (
          <Badge variant="outline">
            <LockIcon className="size-3" />
            <T>Read-only</T>
          </Badge>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-5">
          {conflict ? (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>
                <T>Edit conflict detected</T>
              </AlertTitle>
              <AlertDescription>
                <T>
                  This entry changed in another session (your revision{" "}
                  <Var>{conflict.expectedRevision}</Var>, latest revision{" "}
                  <Var>{conflict.currentRevision}</Var>). Reload to inspect the latest version
                  before saving again.
                </T>
              </AlertDescription>
              <AlertAction>
                <Button
                  size="sm"
                  variant="warning-outline"
                  onClick={() => {
                    setConflict(null);
                    onReload();
                  }}
                >
                  <T>Reload latest</T>
                </Button>
              </AlertAction>
            </Alert>
          ) : null}

          {error ? (
            <Alert variant="error">
              <AlertTriangleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-detail-title">
              <T>Title</T>
            </Label>
            <Input
              id="library-detail-title"
              disabled={!canWrite}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          {isLinkEntryKind(entry.kind) || entry.url ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="library-detail-url">
                <T>Source URL</T>
              </Label>
              <Input
                id="library-detail-url"
                disabled={!canWrite}
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-detail-tags">
              <T>Tags</T>
            </Label>
            <Input
              id="library-detail-tags"
              disabled={!canWrite}
              placeholder={gt("Comma-separated tags")}
              value={tagsText}
              onChange={(event) => setTagsText(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-detail-note">
              <T>Personal note</T>
            </Label>
            <Textarea
              id="library-detail-note"
              disabled={!canWrite}
              rows={4}
              placeholder={gt("Add your own summary, takeaways, or follow-up questions")}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="library-detail-body">
              <T>Captured text</T>
            </Label>
            <Textarea
              id="library-detail-body"
              disabled={!canWrite}
              rows={10}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
        </div>
      </ScrollArea>

      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Delete library entry?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This permanently removes “<Var>{entry.title}</Var>” and its saved notes from this
                environment.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleConfirmDelete()}
            >
              {deleting ? <Spinner className="size-3.5" /> : null}
              <T>Delete entry</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export function LibraryPage({
  requestedEnvironmentId,
  onEnvironmentChange,
}: {
  readonly requestedEnvironmentId?: EnvironmentId | undefined;
  readonly onEnvironmentChange?: ((environmentId: EnvironmentId) => void) | undefined;
}) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const handleNewThread = useNewThreadHandler();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedEnvId, setSelectedEnvId] = useState<EnvironmentId | null>(null);
  const [queryInput, setQueryInput] = useState("");
  const [kindFilter, setKindFilter] = useState<LibraryEntryKind | typeof ALL_KINDS_VALUE>(
    ALL_KINDS_VALUE,
  );
  const [tagFilter, setTagFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<ReadonlyArray<string>>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const [importingFile, setImportingFile] = useState(false);
  const [composingDraft, setComposingDraft] = useState(false);

  const activeEnvironmentId = resolveActiveLibraryEnvironmentId(
    environments.map((env) => ({
      environmentId: env.environmentId,
      supportsLibrary: env.serverConfig?.environment.capabilities.researchLibrary === true,
      connected: env.connection.phase === "connected",
    })),
    selectedEnvId,
    requestedEnvironmentId,
  );

  const activeEnvironment =
    environments.find((env) => env.environmentId === activeEnvironmentId) ?? null;
  const supportsLibrary =
    activeEnvironment?.serverConfig?.environment.capabilities.researchLibrary === true;

  const canRead = useAtomValue(libraryEnvironment.composeDraft.permissionAtom(activeEnvironmentId));
  const canWrite = useAtomValue(libraryEnvironment.save.permissionAtom(activeEnvironmentId));

  const queryEnabled = activeEnvironmentId !== null && supportsLibrary && canRead;

  const trimmedQuery = queryInput.trim();
  const trimmedTag = tagFilter.trim();
  const listInput: LibraryListInput = {
    ...(trimmedQuery.length > 0 ? { query: trimmedQuery } : {}),
    ...(kindFilter !== ALL_KINDS_VALUE ? { kind: kindFilter } : {}),
    ...(trimmedTag.length > 0 ? { tag: trimmedTag } : {}),
    limit: PAGE_SIZE,
    offset,
  };

  const listQuery = useLibraryList(activeEnvironmentId, listInput, queryEnabled);
  const detailQuery = useLibraryEntry(activeEnvironmentId, activeEntryId, queryEnabled);

  const saveCommand = useAtomCommand(libraryEnvironment.save, { reportFailure: false });
  const importTextFileCommand = useAtomCommand(libraryEnvironment.importTextFile, {
    reportFailure: false,
  });
  const updateCommand = useAtomCommand(libraryEnvironment.update, { reportFailure: false });
  const deleteCommand = useAtomCommand(libraryEnvironment.delete, { reportFailure: false });
  const composeDraftCommand = useAtomCommand(libraryEnvironment.composeDraft, {
    reportFailure: false,
  });

  const envProjects = projects.filter((project) => project.environmentId === activeEnvironmentId);
  const activeProject =
    envProjects.find((project) => project.id === selectedProjectId) ?? envProjects[0] ?? null;

  const switchEnvironment = (nextEnvId: EnvironmentId) => {
    setSelectedEnvId(nextEnvId);
    setActiveEntryId(null);
    setSelectedEntryIds([]);
    setSelectedProjectId(null);
    setOffset(0);
    setDraftQuestion("");
    onEnvironmentChange?.(nextEnvId);
  };

  const handleSaveNew = async (input: LibrarySaveInput): Promise<string | null> => {
    if (activeEnvironmentId === null) return gt("No environment selected.");
    const result = await saveCommand({ environmentId: activeEnvironmentId, input });
    if (result._tag === "Failure") {
      return commandFailureText(
        squashAtomCommandFailure(result),
        gt("Could not save library entry."),
      );
    }
    setActiveEntryId(result.value.id);
    setOffset(0);
    return null;
  };

  const handleFileChange = async (file: File | undefined) => {
    if (!file || activeEnvironmentId === null || importingFile) return;
    setImportingFile(true);
    const decoded = await readUtf8TextImportFile(file);
    if (!decoded.ok) {
      setImportingFile(false);
      toastManager.add({
        type: "error",
        title: m(msg("Could not import file")),
        description: decoded.message,
      });
      return;
    }
    const result = await importTextFileCommand({
      environmentId: activeEnvironmentId,
      input: {
        fileName: decoded.fileName,
        content: decoded.content,
      },
    });
    setImportingFile(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("Could not import file")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("The server rejected this file.")),
        ),
      });
      return;
    }
    setActiveEntryId(result.value.id);
    setOffset(0);
  };

  const handleUpdateEntry = async (
    input: LibraryUpdateInput,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly conflict?: ConflictState; readonly message: string }
  > => {
    if (activeEnvironmentId === null) {
      return { ok: false, message: gt("No environment selected.") };
    }
    const result = await updateCommand({ environmentId: activeEnvironmentId, input });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      if (isLibraryEditConflictError(cause)) {
        return {
          ok: false,
          conflict: {
            expectedRevision: cause.expectedRevision,
            currentRevision: cause.currentRevision,
          },
          message: cause.message,
        };
      }
      return {
        ok: false,
        message: commandFailureText(cause, gt("Could not update library entry.")),
      };
    }
    return { ok: true };
  };

  const handleDeleteEntry = async (
    input: LibraryDeleteInput,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly conflict?: ConflictState; readonly message: string }
  > => {
    if (activeEnvironmentId === null) {
      return { ok: false, message: gt("No environment selected.") };
    }
    const result = await deleteCommand({ environmentId: activeEnvironmentId, input });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      if (isLibraryEditConflictError(cause)) {
        return {
          ok: false,
          conflict: {
            expectedRevision: cause.expectedRevision,
            currentRevision: cause.currentRevision,
          },
          message: cause.message,
        };
      }
      return {
        ok: false,
        message: commandFailureText(cause, gt("Could not delete library entry.")),
      };
    }
    setActiveEntryId((current) => (current === input.id ? null : current));
    setSelectedEntryIds((current) => current.filter((id) => id !== input.id));
    return { ok: true };
  };

  const handleComposeDraft = async () => {
    if (
      activeEnvironmentId === null ||
      activeProject === null ||
      selectedEntryIds.length === 0 ||
      draftQuestion.trim().length === 0 ||
      composingDraft
    ) {
      return;
    }
    setComposingDraft(true);
    const result = await composeDraftCommand({
      environmentId: activeEnvironmentId,
      input: {
        entryIds: [...selectedEntryIds],
        question: draftQuestion.trim(),
      },
    });
    setComposingDraft(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: m(msg("Could not compose draft")),
        description: commandFailureText(
          squashAtomCommandFailure(result),
          m(msg("Failed to build library draft context.")),
        ),
      });
      return;
    }
    await handleNewThread(
      { environmentId: activeEnvironmentId, projectId: activeProject.id },
      { prompt: result.value.prompt },
    );
  };

  const items: ReadonlyArray<LibraryEntrySummary> = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;
  const hasMore = listQuery.data?.hasMore ?? false;
  const loadedEntry = detailQuery.data?.entry ?? null;
  const showingEntry =
    loadedEntry !== null && loadedEntry.id === activeEntryId ? loadedEntry : null;

  return (
    <SidebarInset className="flex h-dvh min-w-0 flex-col overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel={gt("Library breadcrumb")}>
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">
              <T context="page title, research library">Library</T>
            </h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="min-w-0 flex-1" />
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          {environments.length > 0 && activeEnvironmentId !== null ? (
            <Select
              value={activeEnvironmentId}
              onValueChange={(next) => {
                if (next) switchEnvironment(next as EnvironmentId);
              }}
            >
              <SelectTrigger aria-label={gt("Environment")} size="sm">
                <SelectValue>{activeEnvironment?.label ?? activeEnvironmentId}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}

          {queryEnabled && canWrite ? (
            <>
              <input
                ref={fileInputRef}
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="sr-only"
                data-testid="library-import-file-input"
                type="file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  void handleFileChange(file);
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={importingFile}
                onClick={() => fileInputRef.current?.click()}
              >
                {importingFile ? <Spinner className="size-3.5" /> : <FileUpIcon />}
                <T>Import file</T>
              </Button>
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <PlusIcon />
                <T>New entry</T>
              </Button>
            </>
          ) : null}

          {queryEnabled ? (
            <Button
              aria-label={gt("Refresh library")}
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                listQuery.refresh();
                if (activeEntryId !== null) detailQuery.refresh();
              }}
            >
              <RefreshIcon refreshing={listQuery.isPending} />
            </Button>
          ) : null}
        </div>
      </WorkspacePageHeader>

      <Separator />

      {activeEnvironment === null ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpenIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>No environment available</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>Connect an environment to browse or collect items in its research library.</T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : !supportsLibrary ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BookOpenIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>Library unavailable on this environment</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>
                  “<Var>{activeEnvironment.label}</Var>” is running an older server that does not
                  advertise research library support. Update that server or switch environments.
                </T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : !canRead ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LockIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>Library access restricted</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>
                  Your current session for “<Var>{activeEnvironment.label}</Var>” does not have
                  permission to read library entries.
                </T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <div className="relative min-w-52 flex-1">
              <Input
                aria-label={gt("Search library")}
                placeholder={gt("Search titles, content, and notes…")}
                size="sm"
                type="search"
                value={queryInput}
                onChange={(event) => {
                  setQueryInput(event.target.value);
                  setOffset(0);
                }}
              />
            </div>
            <div className="w-40">
              <Select
                value={kindFilter}
                onValueChange={(next) => {
                  if (next) {
                    setKindFilter(next as LibraryEntryKind | typeof ALL_KINDS_VALUE);
                    setOffset(0);
                  }
                }}
              >
                <SelectTrigger aria-label={gt("Filter by type")} size="sm">
                  <SelectValue>
                    {kindFilter === ALL_KINDS_VALUE
                      ? gt("All types")
                      : resolveMessage(KIND_LABELS[kindFilter])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL_KINDS_VALUE}>
                    <T>All types</T>
                  </SelectItem>
                  {FILTER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {resolveMessage(KIND_LABELS[kind])}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="w-36">
              <Input
                aria-label={gt("Filter by tag")}
                placeholder={gt("Tag…")}
                size="sm"
                value={tagFilter}
                onChange={(event) => {
                  setTagFilter(event.target.value);
                  setOffset(0);
                }}
              />
            </div>
          </div>

          {selectedEntryIds.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
              <Badge variant="info">
                <T>
                  <Var>{selectedEntryIds.length}</Var>/<Var>{LIBRARY_MAX_DRAFT_ITEMS}</Var> selected
                </T>
              </Badge>
              <div className="w-52">
                {envProjects.length > 0 && activeProject !== null ? (
                  <Select
                    value={activeProject.id}
                    onValueChange={(next) => {
                      if (next) setSelectedProjectId(next as ProjectId);
                    }}
                  >
                    <SelectTrigger aria-label={gt("Target project")} size="sm">
                      <SelectValue>{activeProject.title}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {envProjects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    <T>No projects in this environment</T>
                  </span>
                )}
              </div>
              <div className="min-w-56 flex-1">
                <Input
                  aria-label={gt("Question for draft")}
                  placeholder={gt("Ask a question about the selected entries…")}
                  size="sm"
                  value={draftQuestion}
                  onChange={(event) => setDraftQuestion(event.target.value)}
                />
              </div>
              <Button
                size="sm"
                disabled={
                  composingDraft || activeProject === null || draftQuestion.trim().length === 0
                }
                onClick={() => void handleComposeDraft()}
              >
                {composingDraft ? <Spinner className="size-3.5" /> : <MessageSquarePlusIcon />}
                <T>Open draft</T>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelectedEntryIds([])}>
                <T>Clear</T>
              </Button>
            </div>
          ) : null}

          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
              {listQuery.error ? (
                <div className="p-4">
                  <Alert variant="error">
                    <AlertTriangleIcon />
                    <AlertDescription>{listQuery.error}</AlertDescription>
                  </Alert>
                </div>
              ) : null}

              <ScrollArea className="min-h-0 flex-1">
                {listQuery.isPending && items.length === 0 ? (
                  <div className="flex items-center justify-center p-8">
                    <Spinner className="size-5" />
                  </div>
                ) : items.length === 0 ? (
                  <div className="p-6">
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <SearchIcon />
                        </EmptyMedia>
                        <EmptyTitle>
                          <T>No matching library entries</T>
                        </EmptyTitle>
                        <EmptyDescription>
                          <T>
                            Save a note, link, or UTF-8 Markdown/text file to start building this
                            environment’s library.
                          </T>
                        </EmptyDescription>
                      </EmptyHeader>
                      {canWrite ? (
                        <EmptyContent>
                          <Button size="sm" onClick={() => setCreateOpen(true)}>
                            <PlusIcon />
                            <T>New entry</T>
                          </Button>
                        </EmptyContent>
                      ) : null}
                    </Empty>
                  </div>
                ) : (
                  <div className="flex flex-col divide-y">
                    {items.map((item) => {
                      const checked = selectedEntryIds.includes(item.id);
                      const isActive = item.id === activeEntryId;
                      const selectionDisabled =
                        !checked && selectedEntryIds.length >= LIBRARY_MAX_DRAFT_ITEMS;
                      return (
                        <div
                          key={item.id}
                          className={
                            isActive
                              ? "flex items-start gap-2.5 bg-accent/60 px-3.5 py-3"
                              : "flex items-start gap-2.5 px-3.5 py-3 hover:bg-accent/30"
                          }
                        >
                          <div className="pt-0.5">
                            <Checkbox
                              aria-label={gt("Select {title}", { title: item.title })}
                              checked={checked}
                              disabled={selectionDisabled}
                              onCheckedChange={() => {
                                setSelectedEntryIds((current) =>
                                  toggleDraftSelection(current, item.id),
                                );
                              }}
                            />
                          </div>
                          <button
                            className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                            type="button"
                            onClick={() => setActiveEntryId(item.id)}
                          >
                            <div className="flex items-center gap-1.5">
                              <EntryKindIcon kind={item.kind} />
                              <span className="truncate font-medium text-sm">{item.title}</span>
                            </div>
                            {item.snippet ? (
                              <p className="line-clamp-2 text-muted-foreground text-xs">
                                {item.snippet}
                              </p>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-1 pt-0.5">
                              <Badge size="sm" variant="outline">
                                {resolveMessage(KIND_LABELS[item.kind])}
                              </Badge>
                              {item.matchedPages.map((pageNumber) => (
                                <Badge key={pageNumber} size="sm" variant="info">
                                  p.{pageNumber}
                                </Badge>
                              ))}
                              {item.tags.slice(0, 3).map((tag) => (
                                <Badge key={tag} size="sm" variant="secondary">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>

              <div className="flex items-center justify-between border-t px-3.5 py-2 text-muted-foreground text-xs">
                <span>
                  <Plural
                    n={total}
                    one={
                      <>
                        <Var>{total}</Var> entry
                      </>
                    }
                    other={
                      <>
                        <Var>{total}</Var> entries
                      </>
                    }
                  />
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    aria-label={gt("Previous page")}
                    disabled={offset === 0}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Button
                    aria-label={gt("Next page")}
                    disabled={!hasMore}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => setOffset((current) => current + PAGE_SIZE)}
                  >
                    <ChevronRightIcon />
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-col">
              {activeEntryId === null ? (
                <div className="flex flex-1 items-center justify-center p-6">
                  <Empty>
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <BookOpenIcon />
                      </EmptyMedia>
                      <EmptyTitle>
                        <T>Select an entry</T>
                      </EmptyTitle>
                      <EmptyDescription>
                        <T>
                          Pick an entry to inspect or edit its notes, or check up to{" "}
                          <Var>{LIBRARY_MAX_DRAFT_ITEMS}</Var> entries to start a draft thread.
                        </T>
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </div>
              ) : detailQuery.isPending && showingEntry === null ? (
                <div className="flex flex-1 items-center justify-center p-6">
                  <Spinner className="size-5" />
                </div>
              ) : detailQuery.error && showingEntry === null ? (
                <div className="p-5">
                  <Alert variant="error">
                    <AlertTriangleIcon />
                    <AlertDescription>{detailQuery.error}</AlertDescription>
                  </Alert>
                </div>
              ) : showingEntry !== null ? (
                <LibraryEntryEditor
                  key={`${showingEntry.id}:${showingEntry.revision}`}
                  canWrite={canWrite}
                  entry={showingEntry}
                  onDelete={handleDeleteEntry}
                  onReload={() => {
                    detailQuery.refresh();
                    listQuery.refresh();
                  }}
                  onSave={handleUpdateEntry}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}

      <LibraryCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleSaveNew}
      />
    </SidebarInset>
  );
}

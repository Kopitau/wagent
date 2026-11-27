import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, LibraryFeedKind } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { PauseIcon, PlayIcon, PlusIcon, RefreshCwIcon, RssIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
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
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import {
  libraryEnvironment,
  useLibraryFeeds,
  useLibraryReadingModels,
  useLibraryWkbStatus,
} from "~/state/library";
import { useAtomCommand } from "~/state/use-atom-command";

import { parseTagsInput } from "./libraryFormatting.logic";

export function LibraryFeedsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();

  const feedsQuery = useLibraryFeeds(
    props.environmentId,
    props.open && props.environmentId !== null,
  );
  const modelsQuery = useLibraryReadingModels(
    props.environmentId,
    props.open && props.environmentId !== null,
  );
  const wkbStatusQuery = useLibraryWkbStatus(
    props.environmentId,
    props.open && props.environmentId !== null,
  );

  const upsertFeed = useAtomCommand(libraryEnvironment.upsertFeed, {
    label: "library upsert feed",
    reportFailure: false,
  });
  const setFeedEnabled = useAtomCommand(libraryEnvironment.setFeedEnabled, {
    label: "library toggle feed",
    reportFailure: false,
  });
  const deleteFeed = useAtomCommand(libraryEnvironment.deleteFeed, {
    label: "library delete feed",
    reportFailure: false,
  });
  const runFeedNow = useAtomCommand(libraryEnvironment.runFeedNow, {
    label: "library run feed now",
    reportFailure: false,
  });
  const runWorkHarvest = useAtomCommand(libraryEnvironment.runWorkHarvest, {
    label: "library work harvest",
    reportFailure: false,
  });

  const [name, setName] = useState("");
  const [kind, setKind] = useState<LibraryFeedKind>("arxiv");
  const [url, setUrl] = useState("");
  const [tagsText, setTagsText] = useState("arxiv");
  const [intervalMinutes, setIntervalMinutes] = useState("360");
  const [maxItemsPerRun, setMaxItemsPerRun] = useState("10");
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [dailyAiBudget, setDailyAiBudget] = useState("5");
  const [workProject, setWorkProject] = useState("");
  const [workProjectBlurb, setWorkProjectBlurb] = useState("");
  const [workOverviewBase, setWorkOverviewBase] = useState("");
  const [workReport, setWorkReport] = useState("");
  const [workOverview, setWorkOverview] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const models = modelsQuery.data?.models ?? [];
  const feeds = feedsQuery.data?.feeds ?? [];
  const dailyAiUsed = feedsQuery.data?.dailyAiUsed ?? 0;

  function formatFailure(cause: unknown, fallback: string): string {
    if (cause instanceof Error) {
      return errorDisplayMessage(cause, messages) ?? cause.message;
    }
    return fallback;
  }

  async function handleAddFeed() {
    if (props.environmentId === null || busyKey !== null) return;
    setErrorText(null);
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl) {
      setErrorText(gt("Feed name and URL are required."));
      return;
    }
    const chosenModel = models.find(
      (item) => `${item.instanceId}::${item.model}` === selectedModelKey,
    );
    if (autoSummarize && !chosenModel) {
      setErrorText(gt("Select an explicit model when auto-AI summary is enabled."));
      return;
    }
    const parsedInterval = Number.parseInt(intervalMinutes, 10);
    const parsedMaxItems = Number.parseInt(maxItemsPerRun, 10);
    const parsedDailyBudget = Number.parseInt(dailyAiBudget, 10);
    setBusyKey("create");
    const result = await upsertFeed({
      environmentId: props.environmentId,
      input: {
        name: trimmedName,
        kind,
        url: trimmedUrl,
        tags: parseTagsInput(tagsText),
        enabled: true,
        intervalMinutes: Math.max(
          15,
          Math.min(10_080, Number.isNaN(parsedInterval) ? 360 : parsedInterval),
        ),
        maxItemsPerRun: Math.max(
          1,
          Math.min(50, Number.isNaN(parsedMaxItems) ? 10 : parsedMaxItems),
        ),
        autoSummarize,
        aiInstanceId: autoSummarize && chosenModel ? chosenModel.instanceId : null,
        aiModel: autoSummarize && chosenModel ? chosenModel.model : null,
        dailyAiBudget: Math.max(
          0,
          Math.min(100, Number.isNaN(parsedDailyBudget) ? 5 : parsedDailyBudget),
        ),
      },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      setErrorText(formatFailure(squashAtomCommandFailure(result), gt("Could not save feed.")));
      return;
    }
    setName("");
    setUrl("");
    toastManager.add({
      type: "success",
      title: gt("Feed saved"),
      description: result.value.name,
    });
  }

  async function handleToggleFeed(feedId: string, enabled: boolean) {
    if (props.environmentId === null || busyKey !== null) return;
    setBusyKey(`toggle:${feedId}`);
    setErrorText(null);
    const result = await setFeedEnabled({
      environmentId: props.environmentId,
      input: { id: feedId, enabled },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      setErrorText(
        formatFailure(squashAtomCommandFailure(result), gt("Could not update feed state.")),
      );
      return;
    }
    toastManager.add({
      type: "info",
      title: enabled ? gt("Feed resumed") : gt("Feed paused"),
      description: result.value.name,
    });
  }

  async function handleRunNow(feedId: string) {
    if (props.environmentId === null || busyKey !== null) return;
    setBusyKey(`run:${feedId}`);
    setErrorText(null);
    const result = await runFeedNow({
      environmentId: props.environmentId,
      input: { id: feedId },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      setErrorText(formatFailure(squashAtomCommandFailure(result), gt("Feed run failed.")));
      return;
    }
    const summary = result.value;
    if (summary.skippedPaused) {
      toastManager.add({
        type: "info",
        title: gt("Feed is paused"),
        description: gt("Resume this feed before running it."),
      });
      return;
    }
    toastManager.add({
      type: summary.errors.length > 0 ? "warning" : "success",
      title: gt("Feed harvested"),
      description: gt("Imported {imported}, skipped {dedup} duplicates, summarized {ai}.", {
        imported: summary.importedCount,
        dedup: summary.deduplicatedCount,
        ai: summary.summarizedCount,
      }),
    });
  }

  async function handleDeleteFeed(feedId: string) {
    if (props.environmentId === null || busyKey !== null) return;
    setBusyKey(`delete:${feedId}`);
    setErrorText(null);
    const result = await deleteFeed({
      environmentId: props.environmentId,
      input: { id: feedId },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      setErrorText(formatFailure(squashAtomCommandFailure(result), gt("Could not delete feed.")));
    }
  }

  async function handleWorkHarvest() {
    if (props.environmentId === null || busyKey !== null) return;
    const isLocalWkbAvailable = wkbStatusQuery.data?.available === true;
    const trimmedProject = workProject.trim();
    const trimmedProjectBlurb = workProjectBlurb.trim();
    const trimmedOverviewBase = workOverviewBase.trim();
    const trimmedReport = workReport.trim();
    const trimmedOverview = workOverview.trim();

    if (!isLocalWkbAvailable) {
      if (!trimmedProject || !trimmedReport || !trimmedOverview) {
        setErrorText(
          gt(
            "Project name, extraction report, and overview page are required for remote wkb work submission.",
          ),
        );
        return;
      }
      if (!trimmedOverviewBase && !trimmedProjectBlurb) {
        setErrorText(
          gt(
            "Provide either a project one-line blurb (for a new project) or the existing overview base version.",
          ),
        );
        return;
      }
    }

    setBusyKey("work-harvest");
    setErrorText(null);
    const result = await runWorkHarvest({
      environmentId: props.environmentId,
      input: isLocalWkbAvailable
        ? trimmedProject.length > 0
          ? { project: trimmedProject }
          : {}
        : {
            project: trimmedProject,
            report: trimmedReport,
            ...(trimmedProjectBlurb.length > 0 ? { projectBlurb: trimmedProjectBlurb } : {}),
            files: [
              {
                name: "overview",
                content: trimmedOverview,
                ...(trimmedOverviewBase.length > 0 ? { base: trimmedOverviewBase } : {}),
              },
            ],
          },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      setErrorText(formatFailure(squashAtomCommandFailure(result), gt("wkb work harvest failed.")));
      return;
    }
    setWorkProjectBlurb("");
    setWorkOverviewBase("");
    setWorkReport("");
    setWorkOverview("");
    toastManager.add({
      type: "success",
      title: gt("wkb work synced"),
      description: result.value.summary,
    });
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            <span className="inline-flex items-center gap-2">
              <RssIcon className="size-4" />
              <T>Scheduled Feeds &amp; wkb Work Sync</T>
            </span>
          </DialogTitle>
          <DialogDescription>
            <T>
              Periodically harvest RSS or arXiv papers with deduplication, instant pause, and daily
              AI summary budget caps. Today&apos;s auto-AI summaries used: <Var>{dailyAiUsed}</Var>.
            </T>
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-5">
            {errorText ? (
              <Alert variant="error">
                <AlertDescription>{errorText}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>
                  <T>Configured feeds</T>
                </Label>
                <Badge variant="outline">
                  <T>
                    <Var>{feeds.length}</Var> feeds
                  </T>
                </Badge>
              </div>

              {feeds.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                  <T>No RSS or arXiv feeds configured on this environment yet.</T>
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {feeds.map((feed) => (
                    <div
                      key={feed.id}
                      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-sm">{feed.name}</span>
                            <Badge variant="secondary">{feed.kind.toUpperCase()}</Badge>
                            <Badge variant={feed.enabled ? "outline" : "warning"}>
                              {feed.enabled ? gt("Active") : gt("Paused")}
                            </Badge>
                            {feed.autoSummarize ? (
                              <Badge variant="outline">
                                <T>Auto-AI ({<Var>{feed.dailyAiBudget}</Var>}/day)</T>
                              </Badge>
                            ) : null}
                          </div>
                          <p className="truncate text-muted-foreground text-xs">{feed.url}</p>
                          <p className="text-muted-foreground text-xs">
                            {gt("Every {minutes} min · max {max} items", {
                              minutes: feed.intervalMinutes,
                              max: feed.maxItemsPerRun,
                            })}
                            {feed.lastStatus
                              ? ` · ${gt("Last: {status} ({count} imported)", {
                                  status: feed.lastStatus,
                                  count: feed.lastImportedCount,
                                })}`
                              : ""}
                          </p>
                          {feed.lastError ? (
                            <p className="text-destructive text-xs">{feed.lastError}</p>
                          ) : null}
                        </div>

                        {props.canWrite ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={!feed.enabled || busyKey !== null}
                              onClick={() => void handleRunNow(feed.id)}
                            >
                              {busyKey === `run:${feed.id}` ? (
                                <Spinner className="size-3" />
                              ) : (
                                <RefreshCwIcon className="size-3" />
                              )}
                              <T>Run</T>
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busyKey !== null}
                              onClick={() => void handleToggleFeed(feed.id, !feed.enabled)}
                            >
                              {feed.enabled ? (
                                <>
                                  <PauseIcon className="size-3" />
                                  <T>Pause</T>
                                </>
                              ) : (
                                <>
                                  <PlayIcon className="size-3" />
                                  <T>Resume</T>
                                </>
                              )}
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={gt("Delete feed")}
                              disabled={busyKey !== null}
                              onClick={() => void handleDeleteFeed(feed.id)}
                            >
                              <Trash2Icon className="size-3.5" />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {props.canWrite ? (
              <>
                <Separator />
                <div className="flex flex-col gap-3">
                  <Label>
                    <T>Add RSS / arXiv feed</T>
                  </Label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={gt("Feed name (e.g. arXiv cs.AI)")}
                      className="sm:col-span-2"
                    />
                    <Select
                      value={kind}
                      onValueChange={(next) => {
                        if (next === "rss" || next === "arxiv") setKind(next);
                      }}
                    >
                      <SelectTrigger aria-label={gt("Feed type")}>
                        <SelectValue>{kind === "arxiv" ? "arXiv" : "RSS"}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="arxiv">arXiv</SelectItem>
                        <SelectItem value="rss">RSS</SelectItem>
                      </SelectPopup>
                    </Select>
                  </div>

                  <Input
                    type="url"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://export.arxiv.org/api/query?search_query=cat:cs.AI&max_results=10"
                  />

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Input
                      value={tagsText}
                      onChange={(event) => setTagsText(event.target.value)}
                      placeholder={gt("Tags, comma-separated")}
                    />
                    <Input
                      type="number"
                      min={15}
                      max={10080}
                      value={intervalMinutes}
                      onChange={(event) => setIntervalMinutes(event.target.value)}
                      placeholder={gt("Interval (min)")}
                    />
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={maxItemsPerRun}
                      onChange={(event) => setMaxItemsPerRun(event.target.value)}
                      placeholder={gt("Max items / run")}
                    />
                  </div>

                  <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={autoSummarize}
                        onCheckedChange={(checked) => setAutoSummarize(checked === true)}
                      />
                      <T>Auto-generate 5-point AI summary for newly harvested items</T>
                    </label>
                    {autoSummarize ? (
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div className="sm:col-span-2">
                          <Select
                            value={selectedModelKey}
                            onValueChange={(next) => setSelectedModelKey(next ?? "")}
                          >
                            <SelectTrigger aria-label={gt("Auto-summary model")}>
                              <SelectValue placeholder={gt("Select explicit model")} />
                            </SelectTrigger>
                            <SelectPopup>
                              {models.map((option) => {
                                const value = `${option.instanceId}::${option.model}`;
                                return (
                                  <SelectItem key={value} value={value}>
                                    {`${option.providerLabel} / ${option.label}`}
                                  </SelectItem>
                                );
                              })}
                            </SelectPopup>
                          </Select>
                        </div>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={dailyAiBudget}
                          onChange={(event) => setDailyAiBudget(event.target.value)}
                          placeholder={gt("Daily AI cap")}
                        />
                      </div>
                    ) : null}
                  </div>

                  <Button
                    size="sm"
                    disabled={busyKey !== null}
                    onClick={() => void handleAddFeed()}
                  >
                    {busyKey === "create" ? <Spinner className="size-3.5" /> : <PlusIcon />}
                    <T>Add feed</T>
                  </Button>
                </div>
              </>
            ) : null}

            {props.canWrite &&
            (wkbStatusQuery.data?.available === true ||
              wkbStatusQuery.data?.syncAvailable === true) ? (
              <>
                <Separator />
                <div className="flex flex-col gap-2">
                  <Label htmlFor="library-work-harvest-project">
                    <T>Sync project commits to wkb work</T>
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    {wkbStatusQuery.data?.available === true ? (
                      <T>
                        Runs read-only harvesting against your project repos and records lessons
                        into the wkb work vault. Leave blank to harvest all configured projects.
                      </T>
                    ) : (
                      <T>
                        Submit a structured project progress report and overview page to your remote
                        wkb work vault.
                      </T>
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      id="library-work-harvest-project"
                      value={workProject}
                      onChange={(event) => setWorkProject(event.target.value)}
                      placeholder={
                        wkbStatusQuery.data?.available === true
                          ? gt("Optional project name")
                          : gt("Project name")
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyKey !== null}
                      onClick={() => void handleWorkHarvest()}
                    >
                      {busyKey === "work-harvest" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <RefreshCwIcon className="size-3.5" />
                      )}
                      {wkbStatusQuery.data?.available === true ? (
                        <T>Harvest now</T>
                      ) : (
                        <T>Submit work</T>
                      )}
                    </Button>
                  </div>
                  {wkbStatusQuery.data?.available !== true ? (
                    <div className="grid gap-2 pt-1">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input
                          value={workProjectBlurb}
                          onChange={(event) => setWorkProjectBlurb(event.target.value)}
                          placeholder={gt("New project one-line blurb...")}
                        />
                        <Input
                          value={workOverviewBase}
                          onChange={(event) => setWorkOverviewBase(event.target.value)}
                          placeholder={gt("Existing overview base version (if updating)")}
                        />
                      </div>
                      <Textarea
                        rows={2}
                        value={workReport}
                        onChange={(event) => setWorkReport(event.target.value)}
                        placeholder={gt("Progress report summary...")}
                      />
                      <Textarea
                        rows={3}
                        value={workOverview}
                        onChange={(event) => setWorkOverview(event.target.value)}
                        placeholder={gt("Project overview markdown...")}
                      />
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            <T>Close</T>
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

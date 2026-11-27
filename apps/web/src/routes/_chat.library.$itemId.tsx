import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BookOpenIcon,
  FileTextIcon,
  LockIcon,
} from "lucide-react";
import { useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "~/components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { DeepReadWorkbench } from "~/components/library/DeepReadWorkbench";
import { LibraryPdfPreview } from "~/components/library/LibraryPdfPreview";
import { resolveActiveLibraryEnvironmentId } from "~/components/library/libraryFormatting.logic";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Separator } from "~/components/ui/separator";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { libraryEnvironment, useLibraryEntry } from "~/state/library";

interface LibraryItemRouteSearch {
  env?: string | undefined;
}

function LibraryItemRouteView() {
  const gt = useGT();
  const navigate = useNavigate();
  const { itemId } = Route.useParams();
  const { env } = Route.useSearch();
  const { environments } = useEnvironments();
  const [viewMode, setViewMode] = useState<"deepread" | "rawPdf" | "text">("deepread");

  const activeEnvironmentId = resolveActiveLibraryEnvironmentId(
    environments.map((item) => ({
      environmentId: item.environmentId,
      supportsLibrary: item.serverConfig?.environment.capabilities.researchLibrary === true,
      connected: item.connection.phase === "connected",
    })),
    null,
    env ? (env as EnvironmentId) : undefined,
  );

  const activeEnvironment =
    environments.find((item) => item.environmentId === activeEnvironmentId) ?? null;
  const supportsLibrary =
    activeEnvironment?.serverConfig?.environment.capabilities.researchLibrary === true;
  const canRead = useAtomValue(libraryEnvironment.composeDraft.permissionAtom(activeEnvironmentId));
  const queryEnabled = activeEnvironmentId !== null && supportsLibrary && canRead;

  const detailQuery = useLibraryEntry(activeEnvironmentId, itemId, queryEnabled);
  const entry = detailQuery.data?.entry ?? null;
  const hasPdf = entry !== null && entry.blobSha256 !== null;

  return (
    <SidebarInset className="flex h-dvh min-w-0 flex-col overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigate({
                to: "/library",
                search: activeEnvironmentId ? { env: activeEnvironmentId } : {},
              });
            }}
          >
            <ArrowLeftIcon />
            <T>Library</T>
          </Button>
        </div>
        <WorkspaceBreadcrumb ariaLabel={gt("Library item breadcrumb")}>
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{entry?.title ?? gt("Document reader")}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="min-w-0 flex-1" />
        <div className="flex items-center gap-1.5 [-webkit-app-region:no-drag]">
          <Button
            size="sm"
            variant={viewMode === "deepread" ? "secondary" : "ghost"}
            onClick={() => setViewMode("deepread")}
          >
            <BookOpenIcon />
            <T>DeepRead</T>
          </Button>
          {hasPdf ? (
            <Button
              size="sm"
              variant={viewMode === "rawPdf" ? "secondary" : "ghost"}
              onClick={() => setViewMode("rawPdf")}
            >
              <BookOpenIcon />
              <T>Raw PDF</T>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={viewMode === "text" ? "secondary" : "ghost"}
            onClick={() => setViewMode("text")}
          >
            <FileTextIcon />
            <T>Text & notes</T>
          </Button>
        </div>
      </WorkspacePageHeader>

      <Separator />

      {activeEnvironment === null || !supportsLibrary ? (
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
                <T>Connect an environment that supports research library to view this item.</T>
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
      ) : detailQuery.isPending && entry === null ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <Spinner className="size-5" />
        </div>
      ) : detailQuery.error && entry === null ? (
        <div className="p-5">
          <Alert variant="error">
            <AlertTriangleIcon />
            <AlertDescription>{detailQuery.error}</AlertDescription>
          </Alert>
        </div>
      ) : entry !== null && activeEnvironmentId !== null ? (
        viewMode === "deepread" ? (
          <DeepReadWorkbench environmentId={activeEnvironmentId} entry={entry} />
        ) : hasPdf && viewMode === "rawPdf" ? (
          <LibraryPdfPreview environmentId={activeEnvironmentId} entry={entry} />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
              <div className="flex flex-wrap items-center gap-2">
                {entry.tags.map((tag) => (
                  <Badge key={tag} size="sm" variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
              {entry.note ? (
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="mb-1 font-medium text-muted-foreground text-xs">
                    <T>Personal note</T>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{entry.note}</p>
                </div>
              ) : null}
              <div className="whitespace-pre-wrap text-sm leading-relaxed">{entry.body}</div>
            </div>
          </ScrollArea>
        )
      ) : null}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/library/$itemId")({
  validateSearch: (search: Record<string, unknown>): LibraryItemRouteSearch => {
    const env =
      typeof search.env === "string" && search.env.trim().length > 0 ? search.env : undefined;
    return env ? { env } : {};
  },
  component: LibraryItemRouteView,
});

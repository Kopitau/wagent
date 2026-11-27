import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, LibraryEntry } from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";
import { Suspense, lazy } from "react";

import { FileSurfaceAction } from "~/components/files/fileSurfaceChrome";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Spinner } from "~/components/ui/spinner";
import { m } from "~/i18n/messages";
import { libraryEnvironment } from "~/state/library";
import { useAtomCommand } from "~/state/use-atom-command";

import { buildLibraryItemRouteHref } from "./libraryFormatting.logic";

const LazyPdfViewer = lazy(() => import("~/components/files/PdfViewer"));

export function LibraryPdfPreview({
  environmentId,
  entry,
  showOpenInNewTab = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: LibraryEntry;
  readonly showOpenInNewTab?: boolean | undefined;
}) {
  const gt = useGT();
  const loadPdfBytesCommand = useAtomCommand(libraryEnvironment.loadPdfBytes, {
    reportFailure: false,
  });

  if (entry.blobMissing) {
    return (
      <div className="p-5">
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>
            <T>Original PDF file missing</T>
          </AlertTitle>
          <AlertDescription>
            <T>
              The stored PDF binary could not be found on this environment. Extracted text and
              personal notes remain available in the text view.
            </T>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const openInNewTabHref = buildLibraryItemRouteHref(entry.id, environmentId);

  const loadBytes = async (
    signal: AbortSignal,
    options: { readonly reload: boolean },
  ): Promise<ArrayBuffer> => {
    const result = await loadPdfBytesCommand({
      environmentId,
      input: {
        entryId: entry.id,
        signal,
        reload: options.reload,
      },
    });
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      const message =
        cause instanceof Error
          ? (errorDisplayMessage(cause, m) ?? (cause.message || m(msg("Unable to open PDF."))))
          : m(msg("Unable to open PDF."));
      throw new Error(message);
    }
    return result.value;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center p-8">
            <Spinner className="size-5" />
          </div>
        }
      >
        <LazyPdfViewer
          loadBytes={loadBytes}
          sourceKey={`${environmentId}:${entry.id}:${entry.blobSha256 ?? ""}`}
          positionKey={`library:${environmentId}:${entry.id}`}
          title={entry.title}
          actions={
            showOpenInNewTab ? (
              <FileSurfaceAction
                label={gt("Open reader in new tab")}
                onPress={() => {
                  window.open(openInNewTabHref, "_blank", "noopener,noreferrer");
                }}
              >
                <ExternalLinkIcon className="size-3.5" />
              </FileSurfaceAction>
            ) : undefined
          }
        />
      </Suspense>
    </div>
  );
}

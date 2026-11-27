import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";

import { LibraryPage } from "../components/library/LibraryPage";

interface LibrarySearch {
  readonly env?: EnvironmentId | undefined;
}

function LibraryIndexRoute() {
  const search = useSearch({ from: "/_chat/library/" });
  const navigate = useNavigate();

  return (
    <LibraryPage
      requestedEnvironmentId={search.env}
      onEnvironmentChange={(environmentId) => {
        void navigate({
          to: "/library",
          search: { env: environmentId },
          replace: true,
        });
      }}
    />
  );
}

export const Route = createFileRoute("/_chat/library/")({
  validateSearch: (raw: Record<string, unknown>): LibrarySearch =>
    typeof raw.env === "string" && raw.env.trim().length > 0
      ? { env: EnvironmentId.make(raw.env.trim().slice(0, 200)) }
      : {},
  component: LibraryIndexRoute,
});

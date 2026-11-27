import { Outlet, createFileRoute } from "@tanstack/react-router";

function LibraryRouteLayout() {
  return <Outlet />;
}

export const Route = createFileRoute("/_chat/library")({
  component: LibraryRouteLayout,
});

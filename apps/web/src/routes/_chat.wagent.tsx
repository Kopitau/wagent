import { createFileRoute } from "@tanstack/react-router";

import { WagentPage } from "~/components/wagent/WagentPage";

function WagentRoutePage() {
  return <WagentPage />;
}

export const Route = createFileRoute("/_chat/wagent")({
  component: WagentRoutePage,
});

import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app/AppShell";

export const Route = createFileRoute("/app")({
  head: () => ({ meta: [{ title: "Tethran" }, { name: "description", content: "Tethran on test networks. Test tokens only." }] }),
  component: () => (
      <AppShell><Outlet /></AppShell>
  ),
});

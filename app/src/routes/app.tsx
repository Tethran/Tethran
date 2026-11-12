import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/app/AppShell";

export const Route = createFileRoute("/app")({
  head: () => ({ meta: [{ title: "Tethran demo" }, { name: "description", content: "Tethran demo app on test networks." }] }),
  component: () => (
      <AppShell><Outlet /></AppShell>
  ),
});

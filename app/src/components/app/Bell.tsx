import { Link } from "@tanstack/react-router";
import { Bell as BellIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { useRole } from "@/lib/role";

/** The bell: the current role's unread notifications, refreshed every 2 seconds. */
export function Bell() {
  const role = useRole();
  const q = useQuery({ queryKey: ["notifications", role], queryFn: () => api.notifications(role), refetchInterval: 2000, retry: 0 });
  const unread = q.data?.unread ?? 0;
  return (
    <Link to="/app/notifications" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} data-testid="notif-bell"
      className="relative inline-flex size-11 items-center justify-center rounded-full border hover:border-ink">
      <BellIcon className="size-5" aria-hidden />
      {unread > 0 && (
        <span data-testid="notif-count" className="absolute -top-1 -right-1 grid min-w-5 place-items-center rounded-full bg-lime px-1 font-mono text-[0.68rem] font-semibold text-lime-ink">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Object3D } from "@/components/tethran/Object3D";
import { Skeleton } from "@/components/ui/skeleton";
import type { ObjKey } from "@/lib/objects";


/** Query wrapper for the Tethran API: loading, empty and error states come from the real request. */
export function useApi<T>(key: unknown[], fn: () => Promise<T>) {
  return useQuery({ queryKey: key, queryFn: fn, retry: 1, refetchOnWindowFocus: true });
}

export function LoadingBlock({ rows = 3 }: { rows?: number }) {
  return <div className="grid gap-3" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, k) => <Skeleton key={k} className="h-20 rounded-[var(--radius-card)] bg-line" />)}</div>;
}
export function ErrorBlock({ onRetry, message }: { onRetry: () => void; message?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-[var(--radius-card)] border border-dashed bg-surface p-8 text-center">
      <AlertCircle className="size-8 text-danger" aria-hidden />
      <p className="mt-3 font-medium">We couldn't reach the server.</p>
      <p className="text-sm text-muted-foreground">{message ?? "Your last known status is safe. Check your connection."}</p>
      <button onClick={onRetry} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border px-5 text-sm font-medium hover:border-ink"><RefreshCw className="size-4" aria-hidden />Try again</button>
    </div>
  );
}
export function EmptyBlock({ obj = "contract", title, children }: { obj?: ObjKey; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-[var(--radius-card)] border border-dashed bg-surface p-8 text-center">
      <Object3D name={obj} className="size-28" decorative />
      <p className="mt-2 flex items-center gap-2 font-medium"><Inbox className="size-4 text-muted-foreground" aria-hidden />{title}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** Renders the right state for a query. */
export function Async<T>({ q, empty, isEmpty, children, rows }: { q: UseQueryResult<T>; empty: ReactNode; isEmpty?: (v: NonNullable<T>) => boolean; children: (v: NonNullable<T>) => ReactNode; rows?: number }) {
  if (q.isPending) return <LoadingBlock rows={rows ?? 3} />;
  if (q.isError) return <ErrorBlock onRetry={() => q.refetch()} message={(q.error as Error)?.message} />;
  const v = q.data as NonNullable<T>;
  if (v == null || (isEmpty ? isEmpty(v) : Array.isArray(v) && v.length === 0)) return <>{empty}</>;
  return <>{children(v)}</>;
}

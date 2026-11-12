// Opik tracing for treasury actions. Each public action (create, fund, deposit confirm, webhook, release,
// refund, chargeback) is one trace; every chain call made inside it is a tool span. The trace id is written to
// the treasury_actions table and returned in the response. A nested action (fund inside a deposit confirm)
// joins the trace it is called from instead of starting a new one.
import type { DatabaseSync } from "node:sqlite";
import { currentRun, traceTool, type Tracer } from "../../llm/src/index";
import type { TreasuryChain } from "./chainPort";

/** Wraps every chain method in a tool span of the current trace (no-op when there is none). */
export function tracedChain(chain: TreasuryChain): TreasuryChain {
  return new Proxy(chain, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => traceTool(`chain.${String(prop)}`, { input: { args: args.length } }, () => v.apply(target, args));
    },
  });
}

type AsyncFn = (...args: any[]) => Promise<any>;

/** Runs each listed method of `api` inside a trace and records it. Other members are passed through. */
export function traceActions<T extends Record<string, unknown>>(
  api: T,
  names: (keyof T & string)[],
  deps: { tracer: Tracer; db: DatabaseSync; now: () => Date },
): T {
  const out: Record<string, unknown> = { ...api };
  for (const name of names) {
    const fn = api[name] as unknown as AsyncFn;
    out[name] = async (...args: unknown[]) => {
      const milestoneId = typeof args[0] === "string" && name !== "handleStripeWebhook" ? (args[0] as string)
        : typeof (args[0] as any)?.id === "string" ? (args[0] as any).id : null;
      if (currentRun()) return fn.apply(out, args);
      const record = (traceId: string, outcome: string, tx: string | null) =>
        deps.db.prepare("INSERT INTO treasury_actions (milestone_id, action, outcome, tx, trace_id, at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(milestoneId, name, outcome.slice(0, 300), tx, traceId, deps.now().toISOString());
      let traceId = "";
      try {
        const { traceId: id, result } = await deps.tracer.run(
          { name: `treasury.${name}`, input: { milestone_id: milestoneId }, metadata: { milestone_id: milestoneId, kind: "treasury" }, tags: ["treasury", name] },
          async (run) => {
            traceId = run.traceId;
            return fn.apply(out, args);
          },
        );
        const tx = (result as any)?.escrow_tx ?? (result as any)?.release_tx ?? (result as any)?.refund_tx ?? (result as any)?.tx ?? null;
        record(id, String((result as any)?.outcome ?? "ok"), tx);
        return result && typeof result === "object" && !Array.isArray(result) ? { ...result, trace_id: id } : result;
      } catch (e) {
        if (traceId) record(traceId, `error: ${(e as Error)?.message ?? e}`, null);
        throw e;
      }
    };
  }
  return out as T;
}

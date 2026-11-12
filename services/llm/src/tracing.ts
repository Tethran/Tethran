// Tracing for every LLM attempt and every tool call.
//
// A "run" is one trace (for example one settlement run for one milestone). Inside a run, each LLM attempt and
// each tool call is a span. Code starts a run with `tracer.run(...)`; anything called inside it (the router's
// attempts, tool calls through `traceTool`) attaches to that run automatically, through AsyncLocalStorage.
// The run's trace id is what callers store on their records (settlement_plans.trace_id, reconciliation).
//
// What is sent: names, provider, model, latency, attempt number, token counts, sizes and short status fields.
// Prompts and replies are NOT sent, unless the caller passes them explicitly as span input/output; callers must
// only pass seeded demo data or redacted text. Keys and URLs are never sent.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface TraceRecord {
  provider: string;
  model: string;
  latencyMs: number;
  attempt: number;
  ok: boolean;
  errorKind?: string;
  inputChars: number;
  outputChars: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SpanInput {
  name: string;
  type: "llm" | "tool" | "general" | "guardrail";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  provider?: string;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
}

/** One trace. */
export interface RunHandle {
  readonly traceId: string;
  span(s: SpanInput): void;
}

export interface Tracer {
  /** Called by the router once per attempt. Attaches to the current run if there is one. */
  traceCall(rec: TraceRecord): void | Promise<void>;
  /** Runs `fn` inside a new trace and ends the trace when `fn` settles. */
  run<T>(
    info: { name: string; input?: Record<string, unknown>; metadata?: Record<string, unknown>; tags?: string[] },
    fn: (run: RunHandle) => Promise<T>,
  ): Promise<{ traceId: string; result: T }>;
  /** Sends everything buffered. Call before the process exits. */
  flush(): Promise<void>;
}

const current = new AsyncLocalStorage<RunHandle>();

/** The run the caller is inside, if any. */
export function currentRun(): RunHandle | undefined {
  return current.getStore();
}

function attemptSpan(rec: TraceRecord): SpanInput {
  return {
    name: `${rec.provider}.complete#${rec.attempt}`,
    type: "llm",
    provider: rec.provider,
    model: rec.model,
    input: { inputChars: rec.inputChars },
    output: { outputChars: rec.outputChars, ok: rec.ok },
    metadata: { attempt: rec.attempt, latencyMs: rec.latencyMs, ok: rec.ok, errorKind: rec.errorKind },
    usage: rec.inputTokens !== undefined
      ? { prompt_tokens: rec.inputTokens, completion_tokens: rec.outputTokens, total_tokens: (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0) }
      : undefined,
    error: rec.ok ? undefined : rec.errorKind ?? "error",
  };
}

/**
 * Wraps a tool call in a span of the current run (if any). The span records the tool name, latency, a short
 * input and output summary chosen by the caller, and whether it threw. Returns what `fn` returns.
 */
export async function traceTool<T>(
  name: string,
  summary: { input?: Record<string, unknown>; output?: (r: T) => Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  const run = currentRun();
  const started = Date.now();
  try {
    const r = await fn();
    run?.span({ name, type: "tool", input: summary.input, output: summary.output?.(r), metadata: { latencyMs: Date.now() - started } });
    return r;
  } catch (e) {
    run?.span({ name, type: "tool", input: summary.input, metadata: { latencyMs: Date.now() - started }, error: (e as Error)?.name ?? "error" });
    throw e;
  }
}

/** Keeps everything in memory. Used in tests and when Opik is not configured. */
export class MemoryTracer implements Tracer {
  readonly records: TraceRecord[] = [];
  readonly runs: { traceId: string; name: string; spans: SpanInput[]; metadata?: Record<string, unknown>; output?: unknown }[] = [];

  traceCall(rec: TraceRecord): void {
    this.records.push(rec);
    currentRun()?.span(attemptSpan(rec));
  }

  async run<T>(info: { name: string; metadata?: Record<string, unknown> }, fn: (run: RunHandle) => Promise<T>) {
    const entry = { traceId: randomUUID(), name: info.name, spans: [] as SpanInput[], metadata: info.metadata, output: undefined as unknown };
    this.runs.push(entry);
    const handle: RunHandle = { traceId: entry.traceId, span: (s) => entry.spans.push(s) };
    const result = await current.run(handle, () => fn(handle));
    return { traceId: entry.traceId, result };
  }

  async flush() {}
}

/** Does nothing, but still gives each run an id so records always have one. */
export const noopTracer: Tracer = {
  traceCall() {},
  async run(_info, fn) {
    const handle: RunHandle = { traceId: `local-${randomUUID()}`, span() {} };
    const result = await current.run(handle, () => fn(handle));
    return { traceId: handle.traceId, result };
  },
  async flush() {},
};

/**
 * Opik cloud. Configured from OPIK_API_KEY, OPIK_WORKSPACE and OPIK_PROJECT_NAME (default "tethran").
 * Checked against a real Opik account on 12 Nov 2026 (npm run opik:check). Tracing failures never affect the
 * traced work: every Opik call is wrapped, and an error only disables tracing for that call.
 */
export class OpikTracer implements Tracer {
  private client: any;
  private loading?: Promise<void>;

  constructor(private readonly cfg: { apiKey: string; workspaceName: string; projectName: string }) {}

  private async ready(): Promise<boolean> {
    try {
      this.loading ??= (async () => {
        const mod: any = await import("opik");
        if (typeof mod.disableLogger === "function") mod.disableLogger(); // its log lines include URLs
        this.client = new mod.Opik({ ...this.cfg });
      })();
      await this.loading;
      return true;
    } catch {
      return false;
    }
  }

  traceCall(rec: TraceRecord): void | Promise<void> {
    const run = currentRun();
    if (run) {
      run.span(attemptSpan(rec));
      return;
    }
    // An attempt outside any run gets a trace of its own.
    return this.run({ name: "llm.attempt" }, async () => {
      currentRun()?.span(attemptSpan(rec));
    }).then(() => undefined);
  }

  async run<T>(
    info: { name: string; input?: Record<string, unknown>; metadata?: Record<string, unknown>; tags?: string[] },
    fn: (run: RunHandle) => Promise<T>,
  ): Promise<{ traceId: string; result: T }> {
    let trace: any;
    if (await this.ready()) {
      try {
        trace = this.client.trace({ name: info.name, input: info.input, metadata: info.metadata, tags: info.tags });
      } catch {
        trace = undefined;
      }
    }
    const traceId: string = trace?.data?.id ?? trace?.id ?? `local-${randomUUID()}`;
    const handle: RunHandle = {
      traceId,
      span: (s) => {
        try {
          const span = trace?.span({
            name: s.name, type: s.type === "guardrail" ? "general" : s.type, input: s.input, output: s.output,
            metadata: { ...s.metadata, ...(s.error ? { error: s.error } : {}) }, provider: s.provider, model: s.model, usage: s.usage,
          });
          span?.end();
        } catch {
          // best effort
        }
      },
    };
    try {
      const result = await current.run(handle, () => fn(handle));
      try { trace?.update({ output: { ok: true } }); trace?.end(); } catch { /* best effort */ }
      // Send each run as it ends. Without this the first trace after start-up was observed to be lost.
      await this.flush();
      return { traceId, result };
    } catch (e) {
      try { trace?.update({ output: { ok: false, error: (e as Error)?.name ?? "error" } }); trace?.end(); } catch { /* best effort */ }
      await this.flush();
      throw e;
    }
  }

  async flush(): Promise<void> {
    try {
      if (this.client) await this.client.flush();
    } catch {
      // best effort
    }
  }
}

export function createTracerFromEnv(env: Record<string, string | undefined> = process.env): Tracer {
  if (!env.OPIK_API_KEY || !env.OPIK_WORKSPACE) return noopTracer;
  return new OpikTracer({
    apiKey: env.OPIK_API_KEY,
    workspaceName: env.OPIK_WORKSPACE,
    projectName: env.OPIK_PROJECT_NAME || "tethran",
  });
}

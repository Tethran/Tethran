export interface TraceRecord {
  provider: string;
  model: string;
  latencyMs: number;
  attempt: number;
  ok: boolean;
  errorKind?: string;
  inputChars: number;
  outputChars: number;
}

export interface Tracer {
  traceCall(rec: TraceRecord): void | Promise<void>;
}

// No-op that also keeps records in memory (used in tests).
export class MemoryTracer implements Tracer {
  readonly records: TraceRecord[] = [];
  traceCall(rec: TraceRecord): void {
    this.records.push(rec);
  }
}

export const noopTracer: Tracer = { traceCall() {} };

// Thin Opik adapter. Sends only the fields of TraceRecord: no prompts, replies or keys.
// The Opik client reads OPIK_API_KEY (and workspace/url settings) from the environment itself.
// Unverified against a real Opik account. Tracing failures never affect the LLM call.
export class OpikTracer implements Tracer {
  private client: any;
  private loading?: Promise<void>;

  private async init(): Promise<void> {
    const mod: any = await import("opik");
    this.client = new mod.Opik();
  }

  async traceCall(rec: TraceRecord): Promise<void> {
    try {
      this.loading ??= this.init();
      await this.loading;
      const meta = { provider: rec.provider, model: rec.model, attempt: rec.attempt, ok: rec.ok, errorKind: rec.errorKind };
      const trace = this.client.trace({
        name: "llm.attempt",
        input: { inputChars: rec.inputChars },
        output: { outputChars: rec.outputChars },
        metadata: { ...meta, latencyMs: rec.latencyMs },
      });
      const span = trace.span({
        name: `${rec.provider}.complete`,
        type: "llm",
        provider: rec.provider,
        model: rec.model,
        metadata: { ...meta, latencyMs: rec.latencyMs },
      });
      span.end();
      trace.end();
      await this.client.flush();
    } catch {
      // swallow: tracing is best effort
    }
  }
}

export function createTracerFromEnv(env: Record<string, string | undefined> = process.env): Tracer {
  return env.OPIK_API_KEY ? new OpikTracer() : noopTracer;
}

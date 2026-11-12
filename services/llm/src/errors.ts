import type { AttemptRecord } from "./types.js";

export type ProviderErrorKind = "http" | "timeout" | "network" | "empty_reply" | "bad_response";

// Thrown by a single-attempt adapter. The message never contains URLs, headers, keys or bodies.
export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(opts: { provider: string; kind: ProviderErrorKind; status?: number; retryAfterMs?: number }) {
    const detail = opts.kind === "http" ? `HTTP ${opts.status}` : opts.kind.replace("_", " ");
    super(`${opts.provider} request failed: ${detail}`);
    this.name = "ProviderError";
    this.provider = opts.provider;
    this.kind = opts.kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export class LlmAllFailedError extends Error {
  readonly attempts: AttemptRecord[];
  constructor(attempts: AttemptRecord[]) {
    super(
      `All LLM attempts failed (${attempts.length}): ` +
        (attempts.map((a) => `#${a.attempt} ${a.provider}/${a.model}: ${a.reason}`).join("; ") || "no provider configured"),
    );
    this.name = "LlmAllFailedError";
    this.attempts = attempts;
  }
}

// Parses a Retry-After header: delta-seconds or an HTTP date. Returns milliseconds or undefined.
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, t - nowMs);
}

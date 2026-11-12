import Ajv2020 from "ajv/dist/2020";
import { LlmAllFailedError, LlmConfigError, ProviderError } from "./errors.js";
import { createGeminiAdapter } from "./providers/gemini.js";
import { createGroqAdapter } from "./providers/groq.js";
import { createNvidiaAdapter } from "./providers/nvidia.js";
import { noopTracer, type Tracer } from "./tracing.js";
import type { AttemptRecord, FetchLike, LlmCompletion, LlmProvider, LlmRequest } from "./types.js";

export const KNOWN_PROVIDERS = ["groq", "gemini", "nvidia"] as const;
export type ProviderName = (typeof KNOWN_PROVIDERS)[number];

export const MAX_ATTEMPTS = 3;
export const MAX_TRIES_PER_PROVIDER = 2; // first try plus one retry
export const DEFAULT_BACKOFF_MS = 1000;
export const BACKOFF_CAP_MS = 5000;

export interface ProviderCreds {
  apiKey?: string;
  model?: string;
}

export interface LlmConfig {
  order: string[];
  groq?: ProviderCreds;
  gemini?: ProviderCreds;
  nvidia?: ProviderCreds;
  timeoutMs?: number;
}

export interface LlmDeps {
  fetch: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  tracer?: Tracer;
  now?: () => number;
}

export type RoutedCompletion = LlmCompletion & { attempts: number };

export interface RoutedProvider extends LlmProvider {
  complete(req: LlmRequest): Promise<RoutedCompletion>;
  readonly active: string[]; // providers that will be tried, in order
  readonly skipped: string[]; // key-free messages for providers that were listed but unusable
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  const order = (env.LLM_PROVIDER_ORDER ?? "groq,gemini")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const timeout = env.LLM_TIMEOUT_MS ? Number(env.LLM_TIMEOUT_MS) : undefined;
  return {
    order,
    groq: { apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL },
    gemini: { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL },
    nvidia: { apiKey: env.NVIDIA_API_KEY, model: env.NVIDIA_MODEL },
    timeoutMs: timeout && timeout > 0 ? timeout : undefined,
  };
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = new WeakMap<object, ReturnType<typeof ajv.compile>>();

function getValidator(schema: object) {
  let v = validators.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    validators.set(schema, v);
  }
  return v;
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1]! : t;
}

type Failure = { reason: string; errorKind: string; status?: number; retryAfterMs?: number };

export function createLlmProvider(config: LlmConfig, deps: LlmDeps): RoutedProvider {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tracer = deps.tracer ?? noopTracer;
  const now = deps.now ?? Date.now;

  const unknown = config.order.filter((n) => !(KNOWN_PROVIDERS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new LlmConfigError(`Unknown provider in LLM_PROVIDER_ORDER: ${unknown.join(", ")}`);
  }

  const providers: { name: string; model: string; adapter: LlmProvider }[] = [];
  const skipped: string[] = [];
  for (const name of config.order as ProviderName[]) {
    if (providers.some((p) => p.name === name)) continue;
    const creds = config[name];
    if (!creds?.apiKey || !creds.model) {
      const missing = [!creds?.apiKey ? `${name.toUpperCase()}_API_KEY` : "", !creds?.model ? `${name.toUpperCase()}_MODEL` : ""]
        .filter(Boolean)
        .join(" and ");
      skipped.push(`${name} skipped: ${missing} not set`);
      continue;
    }
    const opts = { apiKey: creds.apiKey, model: creds.model, fetch: deps.fetch, timeoutMs: config.timeoutMs };
    const adapter =
      name === "groq" ? createGroqAdapter(opts) : name === "gemini" ? createGeminiAdapter(opts) : createNvidiaAdapter(opts);
    providers.push({ name, model: creds.model, adapter });
  }

  return {
    active: providers.map((p) => p.name),
    skipped,
    async complete(req: LlmRequest): Promise<RoutedCompletion> {
      const attempts: AttemptRecord[] = [];
      const inputChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
      let total = 0;

      for (const p of providers) {
        let tries = 0;
        while (total < MAX_ATTEMPTS && tries < MAX_TRIES_PER_PROVIDER) {
          total++;
          tries++;
          const started = now();
          let failure: Failure | undefined;
          let raw: LlmCompletion | undefined;
          let outputChars = 0;
          try {
            raw = await p.adapter.complete(req);
            outputChars = raw.text.length;
            let value: unknown;
            try {
              value = JSON.parse(stripFences(raw.text));
            } catch {
              failure = { reason: "invalid JSON", errorKind: "invalid_json" };
            }
            if (!failure) {
              const validate = getValidator(req.jsonSchema);
              if (validate(value)) {
                await safeTrace(tracer, {
                  provider: p.name, model: p.model, latencyMs: raw.latencyMs, attempt: total,
                  ok: true, inputChars, outputChars,
                  inputTokens: raw.usage?.inputTokens, outputTokens: raw.usage?.outputTokens,
                });
                return { ...raw, parsed: value, provider: p.name, model: p.model, attempts: total };
              }
              const first = (validate.errors ?? [])[0];
              failure = {
                reason: `schema mismatch (${(validate.errors ?? []).length} errors, first at ${first?.instancePath || "/"}: ${first?.keyword ?? "invalid"})`,
                errorKind: "schema_mismatch",
              };
            }
          } catch (e) {
            if (e instanceof ProviderError) {
              failure = {
                reason: e.message.replace(/^\w+ request failed: /, ""),
                errorKind: e.status === 429 ? "rate_limited" : `provider_${e.kind}`,
                status: e.status,
                retryAfterMs: e.retryAfterMs,
              };
            } else {
              failure = { reason: "unexpected adapter error", errorKind: "provider_unexpected" };
            }
          }
          attempts.push({ provider: p.name, model: p.model, attempt: total, reason: failure!.reason });
          await safeTrace(tracer, {
            provider: p.name, model: p.model, latencyMs: raw?.latencyMs ?? now() - started, attempt: total,
            ok: false, errorKind: failure!.errorKind, inputChars, outputChars,
          });
          if (failure!.status === 429) {
            // Back off, then fall through to the next provider (no same-provider retry after a 429).
            const wait = Math.min(failure!.retryAfterMs ?? DEFAULT_BACKOFF_MS, BACKOFF_CAP_MS);
            if (total < MAX_ATTEMPTS) await sleep(wait);
            break;
          }
        }
        if (total >= MAX_ATTEMPTS) break;
      }
      throw new LlmAllFailedError(attempts);
    },
  };
}

async function safeTrace(tracer: Tracer, rec: Parameters<Tracer["traceCall"]>[0]): Promise<void> {
  try {
    await tracer.traceCall(rec);
  } catch {
    // tracing must never change the outcome of a call
  }
}

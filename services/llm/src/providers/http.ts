import { ProviderError, parseRetryAfter } from "../errors.js";
import type { AdapterOptions, LlmRequest } from "../types.js";

export const DEFAULT_TIMEOUT_MS = 30_000;

// The schema is also given to the model in text, because JSON mode alone does not enforce it.
export function systemWithSchema(req: LlmRequest): string {
  return (
    `${req.system}\n\nReply with a single JSON object only, no prose and no code fences. ` +
    `It must validate against this JSON schema:\n${JSON.stringify(req.jsonSchema)}`
  );
}

// One HTTP POST with a timeout. Never puts the URL, headers or body in an error.
export async function postJson(
  provider: string,
  opts: AdapterOptions,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await opts.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
    throw new ProviderError({ provider, kind: aborted ? "timeout" : "network" });
  }
  try {
    if (!res.ok) {
      throw new ProviderError({
        provider,
        kind: "http",
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }
    const raw = await res.text();
    try {
      return JSON.parse(raw);
    } catch {
      throw new ProviderError({ provider, kind: "bad_response" });
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const aborted = controller.signal.aborted;
    throw new ProviderError({ provider, kind: aborted ? "timeout" : "network" });
  } finally {
    clearTimeout(timer);
  }
}

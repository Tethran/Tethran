// LlmProvider, exactly as in docs/INTERFACES.md section 7.
export interface LlmRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  jsonSchema: object; // the reply must validate against this (for the agent: INTERFACES section 1)
  temperature: 0;
}

export interface LlmCompletion {
  text: string; // raw reply
  parsed?: unknown; // present only when the reply is valid JSON that passes jsonSchema
  usage: { inputTokens: number; outputTokens: number };
  provider: string; // "groq" | "gemini" | "nvidia"
  model: string;
  latencyMs: number;
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmCompletion>;
}

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface AdapterOptions {
  apiKey: string;
  model: string;
  fetch: FetchLike;
  timeoutMs?: number; // default 30000
  baseUrl?: string; // override for tests / proxies
}

export interface AttemptRecord {
  provider: string;
  model: string;
  attempt: number; // 1-based, across all providers
  reason: string; // short and safe: no URLs, headers, keys or reply bodies
}

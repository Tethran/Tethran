import type { FetchLike } from "../src/types.js";

export interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

export type Reply =
  | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | { throw: Error };

// Fake fetch: replies are consumed in order (the last one repeats). Records every call.
export function fakeFetch(replies: Reply[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if ("throw" in r) throw r.throw;
    const status = r.status ?? 200;
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
      text: async () => r.text ?? JSON.stringify(r.json ?? {}),
    };
  };
  return { fetch, calls };
}

export const openAiOk = (content: string) => ({
  json: { choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
});
export const geminiOk = (content: string) => ({
  json: { candidates: [{ content: { parts: [{ text: content }] } }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } },
});

export const testSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

export const req = {
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  jsonSchema: testSchema,
  temperature: 0 as const,
};

export const GOOD = JSON.stringify({ ok: true });
export const KEY = "sk-test-SECRET-123";

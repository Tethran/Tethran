import { ProviderError } from "../errors.js";
import type { AdapterOptions, LlmCompletion, LlmProvider, LlmRequest } from "../types.js";
import { postJson, systemWithSchema } from "./http.js";

// Shared single-attempt adapter for OpenAI-compatible chat completions (Groq, NVIDIA).
export function createOpenAiCompatAdapter(name: string, defaultBaseUrl: string, opts: AdapterOptions): LlmProvider {
  return {
    async complete(req: LlmRequest): Promise<LlmCompletion> {
      const started = Date.now();
      const json = (await postJson(
        name,
        opts,
        opts.baseUrl ?? defaultBaseUrl,
        { authorization: `Bearer ${opts.apiKey}` },
        {
          model: opts.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: systemWithSchema(req) }, ...req.messages],
        },
      )) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) {
        throw new ProviderError({ provider: name, kind: "empty_reply" });
      }
      return {
        text,
        usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        provider: name,
        model: opts.model,
        latencyMs: Date.now() - started,
      };
    },
  };
}

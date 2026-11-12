import { ProviderError } from "../errors.js";
import type { AdapterOptions, LlmCompletion, LlmProvider, LlmRequest } from "../types.js";
import { postJson, systemWithSchema } from "./http.js";

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export function createGeminiAdapter(opts: AdapterOptions): LlmProvider {
  return {
    async complete(req: LlmRequest): Promise<LlmCompletion> {
      const started = Date.now();
      const url = opts.baseUrl ?? `${GEMINI_BASE}/${encodeURIComponent(opts.model)}:generateContent`;
      const json = (await postJson(
        "gemini",
        opts,
        url,
        { "x-goog-api-key": opts.apiKey }, // header, never the query string
        {
          systemInstruction: { parts: [{ text: systemWithSchema(req) }] },
          contents: req.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        },
      )) as {
        candidates?: { content?: { parts?: { text?: unknown }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const parts = json?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
      if (text.length === 0) throw new ProviderError({ provider: "gemini", kind: "empty_reply" });
      return {
        text,
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        },
        provider: "gemini",
        model: opts.model,
        latencyMs: Date.now() - started,
      };
    },
  };
}

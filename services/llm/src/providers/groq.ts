import type { AdapterOptions, LlmProvider } from "../types.js";
import { createOpenAiCompatAdapter } from "./openai-compat.js";

export const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export function createGroqAdapter(opts: AdapterOptions): LlmProvider {
  return createOpenAiCompatAdapter("groq", GROQ_URL, opts);
}

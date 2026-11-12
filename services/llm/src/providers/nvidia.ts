import type { AdapterOptions, LlmProvider } from "../types.js";
import { createOpenAiCompatAdapter } from "./openai-compat.js";

export const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

export function createNvidiaAdapter(opts: AdapterOptions): LlmProvider {
  return createOpenAiCompatAdapter("nvidia", NVIDIA_URL, opts);
}

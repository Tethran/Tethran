import { proposeSettlement } from "../src/agent.js";
import { createLlmProvider, configFromEnv } from "../src/router.js";
import { createTracerFromEnv } from "../src/tracing.js";
import type { LlmProvider } from "../src/types.js";
import { scenarios, type Scenario } from "./scenarios.js";

// Deterministic fake provider: answers with the scenario's known-good reply. It only exercises the runner.
function fakeProvider(s: Scenario): LlmProvider {
  return {
    async complete() {
      const text = JSON.stringify(s.fakeReply);
      return {
        text, parsed: s.fakeReply, usage: { inputTokens: 0, outputTokens: 0 },
        provider: "fake", model: "fake", latencyMs: 0, attempts: 1,
      } as Awaited<ReturnType<LlmProvider["complete"]>>;
    },
  };
}

export async function runEval(env: Record<string, string | undefined> = process.env): Promise<{ lines: string[]; failed: number }> {
  const lines: string[] = [];
  let failed = 0;
  const useFake = (env.LLM_PROVIDER_ORDER ?? "").trim().toLowerCase() === "fake";

  let shared: LlmProvider | undefined;
  let skipMessage = "SKIPPED: no LLM provider configured";
  if (!useFake) {
    const router = createLlmProvider(configFromEnv(env), { fetch: globalThis.fetch as never, tracer: createTracerFromEnv(env) });
    if (router.active.length > 0) shared = router;
    else if (router.skipped.length > 0) skipMessage += ` (${router.skipped.join("; ")})`;
  }

  for (const s of scenarios) {
    const tag = useFake ? " [FAKE provider: runner check only, no real model]" : "";
    if (!useFake && !shared) {
      lines.push(`SKIPPED ${s.id}: ${skipMessage}`);
      continue;
    }
    const res = await proposeSettlement(s.input, useFake ? fakeProvider(s) : shared!);
    let verdict: string;
    let detail: string;
    if (!res.ok) {
      verdict = "FAIL";
      detail = `provider=${res.attempts.at(-1)?.provider ?? "none"} model=${res.attempts.at(-1)?.model ?? "none"} attempts=${res.attempts.length} reason=${res.reasons[0]}`;
    } else {
      const problem = s.check(res.proposal);
      verdict = problem ? "FAIL" : "PASS";
      detail = `provider=${res.meta.provider} model=${res.meta.model} attempts=${res.meta.attempts}${problem ? ` reason=${problem}` : ""}`;
    }
    if (verdict === "FAIL") failed++;
    lines.push(`${verdict} ${s.id}: ${detail}${tag}${s.note ? ` | note: ${s.note}` : ""}`);
  }
  return { lines, failed };
}

const isMain = process.argv[1] !== undefined && /run\.ts$/.test(process.argv[1]);
if (isMain) {
  runEval().then(({ lines, failed }) => {
    for (const l of lines) console.log(l);
    process.exit(failed > 0 ? 1 : 0);
  });
}

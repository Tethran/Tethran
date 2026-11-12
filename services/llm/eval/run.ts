import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proposeSettlement } from "../src/agent.js";
import { createLlmProvider, configFromEnv } from "../src/router.js";
import { createTracerFromEnv, noopTracer } from "../src/tracing.js";
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
  const tracer = useFake ? noopTracer : createTracerFromEnv(env);
  let skipMessage = "SKIPPED: no LLM provider configured";
  if (!useFake) {
    const router = createLlmProvider(configFromEnv(env), { fetch: globalThis.fetch as never, tracer });
    if (router.active.length > 0) shared = router;
    else if (router.skipped.length > 0) skipMessage += ` (${router.skipped.join("; ")})`;
  }

  // Free tiers rate-limit bursts (Gemini returned HTTP 429 after about 27 calls in 30 minutes), so real runs
  // wait between scenarios. EVAL_SPACING_MS overrides the default of 8 seconds.
  const spacingMs = useFake || !shared ? 0 : Number(env.EVAL_SPACING_MS ?? 8000);
  // EVAL_ONLY=prompt_injection,identity_mismatch runs a small batch (rate limits); unknown names are an error.
  const only = (env.EVAL_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const unknown = only.filter((id) => !scenarios.some((s) => s.id === id));
  if (unknown.length > 0) throw new Error(`EVAL_ONLY names unknown scenarios: ${unknown.join(", ")}`);
  const selected = only.length > 0 ? scenarios.filter((s) => only.includes(s.id)) : scenarios;
  // EVAL_SAVE_DIR keeps each real output (proposal, verdict, provider, trace) for the replay file. Never with fake.
  const saveDir = !useFake && env.EVAL_SAVE_DIR ? env.EVAL_SAVE_DIR : undefined;
  if (saveDir) mkdirSync(saveDir, { recursive: true });
  let first = true;
  for (const s of selected) {
    if (!first && spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
    first = false;
    const tag = useFake ? " [FAKE provider: runner check only, no real model]" : "";
    if (!useFake && !shared) {
      lines.push(`SKIPPED ${s.id}: ${skipMessage}`);
      continue;
    }
    // One trace per scenario, so the nine runs show up as nine traces with their attempts as spans.
    const { traceId, result: res } = await tracer.run(
      { name: `eval.${s.id}`, metadata: { scenario: s.id, kind: "eval" }, tags: ["eval", s.id] },
      () => proposeSettlement(s.input, useFake ? fakeProvider(s) : shared!),
    );
    let verdict: string;
    let detail: string;
    if (!res.ok) {
      verdict = "FAIL";
      detail = `provider=${res.attempts.at(-1)?.provider ?? "none"} model=${res.attempts.at(-1)?.model ?? "none"} attempts=${res.attempts.length} reason=${res.reasons[0]} (${res.attempts.at(-1)?.reason ?? ""})`;
    } else {
      const problem = s.check(res.proposal);
      verdict = problem ? "FAIL" : "PASS";
      detail = `provider=${res.meta.provider} model=${res.meta.model} attempts=${res.meta.attempts}${problem ? ` reason=${problem}` : ""}`;
    }
    if (verdict === "FAIL") failed++;
    if (saveDir && res.ok) {
      writeFileSync(join(saveDir, `${s.id}.json`), JSON.stringify({
        scenario: s.id, verdict, problem: verdict === "PASS" ? null : detail, provider: res.meta.provider, model: res.meta.model,
        trace_id: traceId, at: new Date().toISOString(), gross_amount: s.input.milestone.gross_amount, proposal: res.proposal,
      }, null, 2) + "\n");
    }
    lines.push(`${verdict} ${s.id}: ${detail} trace=${traceId}${tag}${s.note ? ` | note: ${s.note}` : ""}`);
  }
  await tracer.flush();
  return { lines, failed };
}

const isMain = process.argv[1] !== undefined && /run\.ts$/.test(process.argv[1]);
if (isMain) {
  runEval().then(({ lines, failed }) => {
    for (const l of lines) console.log(l);
    process.exit(failed > 0 ? 1 : 0);
  });
}

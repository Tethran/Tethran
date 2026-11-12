// Opik experiment over the nine seeded scenarios.
//   npm run eval:experiment                         real models + Opik (dataset and experiment are written)
//   LLM_PROVIDER_ORDER=fake npm run eval:experiment offline dry run: FAKE provider for agent and judge, NOTHING is written to Opik
//
// Real mode reads only these names from the repo-root .env: LLM_PROVIDER_ORDER, GROQ_API_KEY, GROQ_MODEL, GEMINI_API_KEY,
// GEMINI_MODEL, LLM_TIMEOUT_MS, OPIK_API_KEY, OPIK_WORKSPACE, OPIK_PROJECT_NAME. Keys are never printed or traced.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import dotenv from "dotenv";
import { BaseMetric, Opik, disableLogger, evaluate, type EvaluationScoreResult } from "opik";
import { z } from "zod";
import { proposeSettlement, type AgentInput, type ProposeResult } from "../src/agent.js";
import { PROMPT_VERSION } from "../src/prompt.js";
import { configFromEnv, createLlmProvider } from "../src/router.js";
import { createTracerFromEnv, noopTracer, type Tracer } from "../src/tracing.js";
import type { LlmProvider } from "../src/types.js";
import { JUDGE_PROMPT_VERSION, judgeProposal, type JudgeVerdict } from "./judge.js";
import { datasetItemFor, deterministicScores, scenarioById, type Score } from "./metrics.js";
import { scenarios, type Scenario } from "./scenarios.js";

export const DATASET_NAME = "tethran-agent-scenarios";
export const ENV_ALLOWLIST = [
  "LLM_PROVIDER_ORDER", "GROQ_API_KEY", "GROQ_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL", "LLM_TIMEOUT_MS",
  "OPIK_API_KEY", "OPIK_WORKSPACE", "OPIK_PROJECT_NAME",
] as const;

/** Reads only the allowlisted names from the nearest .env above `from`. Other variables in the file are never loaded. */
export function loadAllowlistedEnv(from: string = process.cwd()): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  let dir = resolve(from);
  let file: string | undefined;
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) { file = candidate; break; }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const parsed = file ? dotenv.parse(readFileSync(file)) : {};
  for (const name of ENV_ALLOWLIST) out[name] = parsed[name] ?? process.env[name];
  return out;
}

// ---------- fake providers (offline dry run only) ----------

function fakeLlm(): LlmProvider {
  return {
    async complete(req) {
      const title = (req.jsonSchema as { title?: string }).title;
      if (title === "JudgeVerdict") {
        const v: JudgeVerdict = { score: 1, faithful_to_evidence: true, refused_injection: true, reason: "FAKE judge: always 1" };
        return { text: JSON.stringify(v), parsed: v, usage: { inputTokens: 0, outputTokens: 0 }, provider: "fake", model: "fake", latencyMs: 0 };
      }
      // Agent: find the scenario by the milestone id in the trusted block and answer with its known-good reply.
      const id = /"milestone":\{"id":"([^"]+)"/.exec(req.messages[0]?.content ?? "")?.[1];
      const s = scenarios.find((x) => x.input.milestone.id === id);
      const reply = s?.fakeReply ?? {};
      return { text: JSON.stringify(reply), parsed: reply, usage: { inputTokens: 0, outputTokens: 0 }, provider: "fake", model: "fake", latencyMs: 0 };
    },
  };
}

// ---------- pacing ----------

function makePacer(minGapMs: number): () => Promise<void> {
  let last = 0;
  return async () => {
    const wait = last + minGapMs - Date.now();
    if (last > 0 && wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  };
}

// ---------- rows ----------

export interface Row {
  scenario: string;
  ok: boolean;
  scores: Score[];
  judge: { value: number; reason: string } | null;
  provider: string;
  traceId: string;
  addedFlags: string[];
}

const passed = (r: Row) => r.ok && r.scores.every((s) => s.value === 1);

// ---------- metrics ----------

type Item = { scenario_id?: string; input?: AgentInput; result?: ProposeResult };

class DeterministicMetric extends BaseMetric {
  readonly validationSchema = z.object({}).passthrough();
  constructor(private readonly onScores: (id: string, scores: Score[]) => void) {
    super("deterministic_checks", false);
  }
  score(input: unknown): EvaluationScoreResult[] {
    const it = input as Item;
    const s = scenarioById(it.scenario_id ?? "");
    if (!s || !it.result) return [{ name: "scenario_check", value: 0, reason: "missing scenario or result", scoringFailed: true }];
    const scores = deterministicScores(s, it.result);
    this.onScores(s.id, scores);
    return scores;
  }
}

class JudgeMetric extends BaseMetric {
  readonly validationSchema = z.object({}).passthrough();
  constructor(
    private readonly llm: LlmProvider,
    private readonly pace: () => Promise<void>,
    private readonly onJudge: (id: string, j: { value: number; reason: string } | null) => void,
  ) {
    super("judge_faithfulness", false);
  }
  async score(input: unknown): Promise<EvaluationScoreResult> {
    const it = input as Item;
    const s = scenarioById(it.scenario_id ?? "");
    if (!s || !it.result || !it.result.ok) {
      this.onJudge(s?.id ?? "?", null);
      return { name: "judge_faithfulness", value: 0, reason: "no proposal to judge" };
    }
    await this.pace();
    const j = await judgeProposal(it.input ?? s.input, it.result.proposal, this.llm);
    if (!j.ok) {
      this.onJudge(s.id, null);
      return { name: "judge_faithfulness", value: 0, reason: j.reason, scoringFailed: true };
    }
    const out = { value: j.verdict.score, reason: j.verdict.reason };
    this.onJudge(s.id, out);
    return { name: "judge_faithfulness", ...out };
  }
}

// ---------- the run ----------

export interface ExperimentResult {
  fake: boolean;
  datasetName: string;
  experimentName: string;
  rows: Row[];
  resultUrl?: string;
  rateLimited: boolean;
  lines: string[];
}

export async function runExperiment(env: Record<string, string | undefined>): Promise<ExperimentResult> {
  const fake = (env.LLM_PROVIDER_ORDER ?? "").trim().toLowerCase() === "fake";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const experimentName = `${fake ? "DRYRUN-" : ""}agent-${PROMPT_VERSION}-${stamp}`;
  const spacingMs = fake ? 0 : Number(env.EVAL_SPACING_MS ?? 8000);
  const pace = makePacer(spacingMs);

  let llm: LlmProvider;
  let tracer: Tracer = noopTracer;
  let activeProviders: string[] = ["fake"];
  if (fake) {
    llm = fakeLlm();
  } else {
    tracer = createTracerFromEnv(env);
    const router = createLlmProvider(configFromEnv(env), { fetch: globalThis.fetch as never, tracer });
    if (router.active.length === 0) throw new Error(`no LLM provider configured (${router.skipped.join("; ") || "none listed"})`);
    llm = router;
    activeProviders = router.active;
  }

  const rowsById = new Map<string, Row>();
  const row = (id: string): Row => {
    let r = rowsById.get(id);
    if (!r) rowsById.set(id, (r = { scenario: id, ok: false, scores: [], judge: null, provider: "-", traceId: "-", addedFlags: [] }));
    return r;
  };
  let consecutiveFailures = 0;
  let rateLimited = false;

  // The task: one traced agent run per dataset item.
  const task = async (item: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = String(item.scenario_id);
    const input = item.input as AgentInput;
    if (consecutiveFailures >= 2) {
      // Two providers-exhausted failures in a row: stop spending free-tier quota. No retry loop.
      rateLimited = true;
      return { scenario_id: id, result: { ok: false, decision: "rejected", reasons: ["SCHEMA_INVALID"], attempts: [{ provider: "none", model: "none", attempt: 0, reason: "skipped after repeated failures" }] } };
    }
    await pace();
    const { traceId, result } = await tracer.run(
      { name: `experiment.${id}`, metadata: { scenario: id, kind: "eval-experiment", prompt_version: PROMPT_VERSION, experiment: experimentName }, tags: ["eval", "experiment", id] },
      () => proposeSettlement(input, llm),
    );
    const r = row(id);
    r.traceId = traceId;
    r.ok = result.ok;
    if (result.ok) {
      consecutiveFailures = 0;
      r.provider = `${result.meta.provider}/${result.meta.model}`;
      r.addedFlags = result.addedFlags ?? [];
    } else {
      consecutiveFailures++;
      r.provider = result.attempts.at(-1)?.provider ?? "none";
    }
    return { scenario_id: id, result };
  };

  const detMetric = new DeterministicMetric((id, scores) => { row(id).scores = scores; });
  const judgeMetric = new JudgeMetric(llm, pace, (id, j) => { row(id).judge = j; });

  let resultUrl: string | undefined;
  let finalName = experimentName;
  if (fake) {
    // Offline: same task and metrics, no Opik of any kind.
    for (const s of scenarios) {
      const item = datasetItemFor(s);
      const out = await task(item);
      const merged = { ...item, ...out };
      await detMetric.score(merged);
      await judgeMetric.score(merged);
    }
  } else {
    if (!env.OPIK_API_KEY || !env.OPIK_WORKSPACE) throw new Error("OPIK_API_KEY and OPIK_WORKSPACE are required for a real experiment");
    disableLogger();
    const client = new Opik({ apiKey: env.OPIK_API_KEY, workspaceName: env.OPIK_WORKSPACE, projectName: env.OPIK_PROJECT_NAME || "tethran" });
    const dataset = await client.getOrCreateDataset(DATASET_NAME, "Tethran Settlement Agent: nine seeded scenarios (test data only)");
    // Idempotent: insert only scenarios that are not in the dataset yet.
    const existing = new Set((await dataset.getItems()).map((i) => String((i as { scenario_id?: unknown }).scenario_id)));
    const missing = scenarios.filter((s) => !existing.has(s.id)).map(datasetItemFor);
    if (missing.length > 0) await dataset.insert(missing as never);
    const res = await evaluate({
      dataset,
      task: task as never,
      scoringMetrics: [detMetric, judgeMetric],
      experimentName,
      projectName: env.OPIK_PROJECT_NAME || "tethran",
      experimentConfig: {
        prompt_version: PROMPT_VERSION, judge_prompt_version: JUDGE_PROMPT_VERSION, providers: activeProviders,
        dataset: DATASET_NAME, spacing_ms: spacingMs,
      },
      tags: ["agent", PROMPT_VERSION],
      taskThreads: 1,
      client,
    });
    finalName = res.experimentName ?? experimentName;
    resultUrl = res.resultUrl;
    await client.flush();
    await tracer.flush();
  }

  const rows = scenarios.map((s) => row(s.id));
  const lines = formatTable(rows, { fake, experimentName: finalName, resultUrl });
  return { fake, datasetName: DATASET_NAME, experimentName: finalName, rows, resultUrl, rateLimited, lines };
}

function formatTable(rows: Row[], o: { fake: boolean; experimentName: string; resultUrl?: string }): string[] {
  const cols = ["scenario", "verdict", "check", "schema", "payee", "tax", "human", "inject", "judge", "provider"];
  const cell = (r: Row): string[] => {
    const v = (n: string) => (r.scores.find((s) => s.name === n)?.value === 1 ? "1" : "0");
    return [
      r.scenario, passed(r) ? "PASS" : "FAIL", v("scenario_check"), v("schema_valid"), v("no_unlisted_payee"), v("tax_reserve_ok"),
      v("needs_human_as_expected"), v("injection_resisted"), r.judge ? r.judge.value.toFixed(2) : "n/a", r.provider,
    ];
  };
  const data = [cols, ...rows.map(cell)];
  const w = cols.map((_, i) => Math.max(...data.map((d) => d[i]!.length)));
  const fmt = (d: string[]) => d.map((c, i) => c.padEnd(w[i]!)).join("  ");
  const lines: string[] = [];
  if (o.fake) lines.push("FAKE PROVIDER DRY RUN: agent and judge are fakes, nothing was written to Opik. This says nothing about any model.");
  lines.push(`dataset: ${DATASET_NAME}${o.fake ? " (not touched)" : ""}`);
  lines.push(`experiment: ${o.experimentName}${o.fake ? " (not created)" : ""}`);
  lines.push(fmt(data[0]!), ...data.slice(1).map(fmt));
  for (const r of rows) {
    for (const s of r.scores) if (s.value !== 1) lines.push(`  ${r.scenario}: ${s.name} failed: ${s.reason}`);
    if (r.judge && r.judge.value < 1) lines.push(`  ${r.scenario}: judge ${r.judge.value.toFixed(2)}: ${r.judge.reason}`);
  }
  const judged = rows.filter((r) => r.judge);
  const avg = judged.length ? (judged.reduce((n, r) => n + r.judge!.value, 0) / judged.length).toFixed(2) : "n/a";
  lines.push(`passed ${rows.filter(passed).length}/${rows.length}; judge average ${avg} over ${judged.length} scored`);
  if (o.resultUrl) lines.push(`results: ${o.resultUrl}`);
  return lines;
}

const isMain = process.argv[1] !== undefined && /experiment\.ts$/.test(process.argv[1]);
if (isMain) {
  const fake = (process.env.LLM_PROVIDER_ORDER ?? "").trim().toLowerCase() === "fake";
  const env = fake ? { LLM_PROVIDER_ORDER: "fake" } : loadAllowlistedEnv();
  runExperiment(env)
    .then((r) => {
      for (const l of r.lines) console.log(l);
      if (r.rateLimited) console.log("NOTE: stopped calling models after two consecutive provider failures (likely a free-tier rate limit).");
      process.exit(0);
    })
    .catch((e) => {
      const msg = String((e as Error)?.message ?? e).replace(/\b(?:https?):\/\/[^\s"']+/g, "[url removed]");
      console.error(`FAILED: ${(e as Error)?.name ?? "Error"}: ${msg.slice(0, 300)}`);
      process.exit(1);
    });
}

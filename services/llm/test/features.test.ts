import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeSettlement, type SettlementProposal } from "../src/agent.js";
import { postCheck } from "../src/postcheck.js";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "../src/prompt.js";
import { SUMMARY_DISCLAIMER, summarizeEvidence } from "../src/summarize.js";
import {
  AGENT_TOOL_NAMES, SimulatedPaidDataSource, SpendingCap, SpendingCapExceededError, createAgentTools, gatherAgentInput,
} from "../src/tools.js";
import { MemoryTracer } from "../src/tracing.js";
import type { LlmProvider } from "../src/types.js";
import { judgeProposal } from "../eval/judge.js";
import { runExperiment } from "../eval/experiment.js";
import { scenarios } from "../eval/scenarios.js";

const input = scenarios[0]!.input;
const good = scenarios[0]!.fakeReply;
const providerOf = (reply: unknown): LlmProvider => ({
  complete: async () => ({ text: JSON.stringify(reply), parsed: reply, usage: { inputTokens: 1, outputTokens: 1 }, provider: "fake", model: "fake", latencyMs: 0 }),
});

// ---- prompt ----

test("prompt contains all six skeleton sections in order, plus both worked examples", () => {
  const heads = ["# 1. Role", "# 2. Authority", "# 3. Input trust", "# 4. Procedure", "# 5. Output", "# 6. Worked examples"];
  let at = -1;
  for (const h of heads) {
    const i = SYSTEM_PROMPT.indexOf(h);
    assert.ok(i > at, `${h} missing or out of order`);
    at = i;
  }
  assert.ok(/injection/i.test(SYSTEM_PROMPT) && /over limit/i.test(SYSTEM_PROMPT));
  assert.match(PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

test("PROMPT_VERSION is recorded in the trace", async () => {
  const tracer = new MemoryTracer();
  await tracer.run({ name: "t" }, () => proposeSettlement(input, providerOf(good)));
  const cfg = tracer.runs[0]!.spans.find((s) => s.name === "agent.config");
  assert.equal(cfg?.metadata?.prompt_version, PROMPT_VERSION);
  const r = await proposeSettlement(input, providerOf(good));
  assert.ok(r.ok && r.meta.promptVersion === PROMPT_VERSION);
});

// ---- post-checks ----

const withActions = (actions: Record<string, unknown>[], over: Partial<SettlementProposal> = {}): SettlementProposal => ({ ...(good as SettlementProposal), actions, needs_human: false, flags: [], ...over });

test("post-check flags an unlisted payee and forces needs_human, keeping the action for the Policy Service", () => {
  const p = withActions([{ type: "payout", payee_id: "payee_evil", amount: "900000000", asset: "USDT" }, { type: "tax_reserve", amount: "100000000", reason: "r" }]);
  const r = postCheck(p, input);
  assert.ok(r.added.includes("UNLISTED_PAYEE"));
  assert.equal(r.proposal.needs_human, true);
  assert.equal(r.proposal.actions.length, 2);
});

test("post-check flags sums above gross, non-integer amounts and a low tax reserve", () => {
  const over = postCheck(withActions([{ type: "payout", payee_id: "payee_amara", amount: "950000000", asset: "USDT" }, { type: "tax_reserve", amount: "100000000", reason: "r" }]), input);
  assert.ok(over.added.includes("AMOUNT_EXCEEDS_GROSS") && over.proposal.needs_human);
  const bad = postCheck(withActions([{ type: "payout", payee_id: "payee_amara", amount: "0900", asset: "USDT" }]), input);
  assert.ok(bad.added.includes("INVALID_AMOUNT") && bad.proposal.needs_human);
  const tax = postCheck(withActions([{ type: "payout", payee_id: "payee_amara", amount: "950000000", asset: "USDT" }, { type: "tax_reserve", amount: "50000000", reason: "r" }]), input);
  assert.ok(tax.added.includes("TAX_RESERVE_BELOW_MIN"));
});

test("post-check leaves a good proposal alone and never lowers needs_human", () => {
  const ok = postCheck(withActions([{ type: "payout", payee_id: "payee_amara", amount: "900000000", asset: "USDT" }, { type: "tax_reserve", amount: "100000000", reason: "r" }]), input);
  assert.deepEqual(ok.added, []);
  assert.equal(ok.proposal.needs_human, false);
  const keep = postCheck(withActions([], { needs_human: true }), input);
  assert.equal(keep.proposal.needs_human, true);
});

test("proposeSettlement applies post-checks end to end", async () => {
  const bad = { ...good, actions: [{ type: "payout", payee_id: "payee_evil", amount: "2000000000", asset: "USDT" }], needs_human: false };
  const r = await proposeSettlement(input, providerOf(bad));
  assert.ok(r.ok);
  if (r.ok) {
    assert.ok(["UNLISTED_PAYEE", "AMOUNT_EXCEEDS_GROSS"].every((c) => r.proposal.flags.some((f) => f.code === c)));
    assert.equal(r.proposal.needs_human, true);
  }
});

// ---- summaries ----

const summaryReply = { summary: "Files delivered.", supporting_points: ["ev-1: delivered"], against_points: [], missing_items: [], confidence: 0.8 };

test("summarizeEvidence returns the structured summary with the fixed disclaimer, traced", async () => {
  const tracer = new MemoryTracer();
  const { result } = await tracer.run({ name: "s" }, () => summarizeEvidence(input, providerOf({ ...summaryReply, disclaimer: "model tried to change this" })));
  // the model's extra field is rejected by the model schema only on real providers; here the code overrides the disclaimer
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.summary.disclaimer, SUMMARY_DISCLAIMER);
  assert.ok(tracer.runs[0]!.spans.some((s) => s.name === "summarize_evidence"));
});

test("summarizeEvidence rejects invalid replies and surfaces guard findings", async () => {
  assert.deepEqual(await summarizeEvidence(input, providerOf({ summary: "x" })), { ok: false, reason: "SUMMARY_INVALID" });
  assert.deepEqual(await summarizeEvidence(input, { complete: async () => { throw new Error("x"); } }), { ok: false, reason: "SUMMARY_INVALID" });
  let seen = "";
  const llm: LlmProvider = { complete: async (req) => { seen = req.messages[0]!.content; return providerOf(summaryReply).complete(req); } };
  const inj = scenarios.find((s) => s.id === "prompt_injection")!;
  const r = await summarizeEvidence(inj.input, llm);
  assert.ok(r.ok && r.summary.against_points[0]!.includes("IGNORE_RULES"));
  assert.match(seen, /<<<UNTRUSTED_EVIDENCE#[0-9a-f]+/);
});

// ---- tools ----

const read = {
  getContract: () => input.contract_text,
  getMilestone: () => input.milestone,
  getEvidence: () => input.evidence,
  getPolicySummary: () => input.policy_summary,
};

test("no tool can submit or sign a transaction", () => {
  assert.ok(AGENT_TOOL_NAMES.every((n) => !/submit|sign|send|broadcast|transfer|release/.test(n)));
  const tools = createAgentTools({ read, paid: new SimulatedPaidDataSource(), spendingCapBaseUnits: 100_000n });
  assert.ok(Object.keys(tools).every((k) => !/submit|sign|send|broadcast/.test(k)));
});

test("spending cap is enforced in code before anything is bought", async () => {
  const cap = new SpendingCap(25_000n);
  cap.charge("a", 20_000n);
  assert.throws(() => cap.charge("b", 10_000n), SpendingCapExceededError);
  assert.equal(cap.spent, 20_000n);
  const tools = createAgentTools({ read, paid: new SimulatedPaidDataSource({ corridor_rules: 20_000n, fx_quote: 10_000n }), spendingCapBaseUnits: 25_000n });
  const rules = await tools.buy_corridor_rules("NG-KE");
  assert.equal(rules.simulated, true);
  assert.equal(rules.source, "SIMULATED_X402_DEMO");
  await assert.rejects(() => tools.buy_fx_quote("USDT", "KES"), SpendingCapExceededError);
  assert.equal(tools.cap.spent, 20_000n);
});

test("tool calls are traced, and gatherAgentInput builds an AgentInput and skips purchases over the cap", async () => {
  const tracer = new MemoryTracer();
  const tools = createAgentTools({ read, paid: new SimulatedPaidDataSource({ corridor_rules: 20_000n, fx_quote: 10_000n }), spendingCapBaseUnits: 25_000n });
  const { result } = await tracer.run({ name: "g" }, () =>
    gatherAgentInput(tools, { milestoneId: input.milestone.id, payees: input.payees, tax_profile: input.tax_profile, buy: { corridor: "NG-KE", fx: { from: "USDT", to: "KES" } } }));
  assert.equal(result.milestone.id, input.milestone.id);
  assert.deepEqual(result.paid_data?.map((d) => d.tool), ["buy_corridor_rules"]); // the second purchase would exceed the cap
  assert.ok(result.paid_data?.every((d) => d.simulated));
  const names = tracer.runs[0]!.spans.map((s) => s.name);
  for (const n of ["get_contract", "get_milestone", "get_evidence", "get_policy_summary", "buy_corridor_rules", "buy_fx_quote"]) assert.ok(names.includes(n), n);
  assert.ok(tracer.runs[0]!.spans.find((s) => s.name === "buy_fx_quote")!.error);
  // paid data reaches the model as a delimited, untrusted block
  let seen = "";
  await proposeSettlement(result, { complete: async (req) => { seen = req.messages[0]!.content; return providerOf(good).complete(req); } });
  assert.match(seen, /<<<UNTRUSTED_PAID_DATA#[0-9a-f]+/);
  assert.ok(seen.includes("SIMULATED demo corridor rules"));
});

// ---- judge and experiment ----

test("judge parses its verdict, passes data delimited, and fails safe", async () => {
  let seen = "";
  const llm: LlmProvider = { complete: async (req) => { seen = req.messages[0]!.content; return providerOf({ score: 0.8, faithful_to_evidence: true, refused_injection: true, reason: "ok" }).complete(req); } };
  const j = await judgeProposal(input, good, llm);
  assert.ok(j.ok && j.verdict.score === 0.8);
  assert.match(seen, /<<<PROPOSAL_JSON#[0-9a-f]+/);
  assert.equal((await judgeProposal(input, good, providerOf({ score: 7 }))).ok, false);
  assert.equal((await judgeProposal(input, good, { complete: async () => { throw new Error("x"); } })).ok, false);
});

test("experiment runner in fake mode produces nine rows, labelled fake, and touches nothing real", async () => {
  const r = await runExperiment({ LLM_PROVIDER_ORDER: "fake" });
  assert.equal(r.fake, true);
  assert.equal(r.rows.length, 9);
  assert.ok(r.rows.every((x) => x.ok && x.scores.length === 6 && x.judge?.value === 1));
  assert.ok(r.lines[0]!.startsWith("FAKE PROVIDER DRY RUN"));
  assert.ok(r.lines.some((l) => l.includes("tethran-agent-scenarios") && l.includes("not touched")));
  assert.equal(r.resultUrl, undefined);
  assert.ok(r.experimentName.startsWith("DRYRUN-"));
});

test("a real run without keys fails before any call", async () => {
  await assert.rejects(() => runExperiment({ LLM_PROVIDER_ORDER: "groq" }), /no LLM provider configured/);
});

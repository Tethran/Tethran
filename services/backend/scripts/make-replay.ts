// Builds replay/proposals.json, one saved proposal per seeded scenario.
//
// Source, per scenario:
//   1. a REAL model output saved by the agent eval (services/llm/eval/out/<scenario>.json, written with
//      EVAL_SAVE_DIR=eval/out npm run eval:agent) that PASSED its scenario check;
//   2. otherwise the scenario's curated expected reply, labelled "curated" in `source` (and shown as such in the
//      replay label of every settlement that uses it).
// Usage: npx tsx scripts/make-replay.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scenarios } from "../../llm/eval/scenarios";

const OUT = resolve(__dirname, "../../llm/eval/out");
const ppm = (amount: string, gross: string) => Number((BigInt(amount) * 1_000_000n) / BigInt(gross));
const shape = (r: any, gross: string) => ({
  confidence: r.confidence,
  evidence_used: r.evidence_used,
  flags: r.flags,
  needs_human: r.needs_human,
  actions: (r.actions as any[]).map(({ amount, ...rest }) => ({ ...rest, amount_ppm: ppm(String(amount), gross) })),
});

let real = 0;
const rows = scenarios.map((s) => {
  const file = resolve(OUT, `${s.id}.json`);
  if (existsSync(file)) {
    const run = JSON.parse(readFileSync(file, "utf8"));
    if (run.verdict === "PASS" && run.proposal) {
      real++;
      return {
        scenario: s.id,
        source: `real model output: ${run.provider}/${run.model}, eval run ${String(run.at).slice(0, 10)}, Opik trace ${run.trace_id}`,
        proposal: shape(run.proposal, run.gross_amount),
      };
    }
  }
  return {
    scenario: s.id,
    source: "curated: the scenario's expected reply (not a model run); no passing real output saved yet",
    proposal: shape(s.fakeReply, s.input.milestone.gross_amount),
  };
});
writeFileSync(resolve(__dirname, "../replay/proposals.json"), JSON.stringify(rows, null, 2) + "\n");
console.log(`wrote ${rows.length} saved proposals: ${real} real model outputs, ${rows.length - real} curated`);

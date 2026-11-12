// Builds replay/proposals.json from the seeded scenarios' expected replies (curated, not model output).
// To save real model output instead, run the agent eval with saving on and replace the file.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scenarios } from "../../llm/eval/scenarios";

const rows = scenarios.map((s) => {
  const gross = BigInt(s.input.milestone.gross_amount);
  const r: any = s.fakeReply;
  return {
    scenario: s.id,
    source: "curated: the scenario's expected reply (not a model run)",
    proposal: {
      confidence: r.confidence,
      evidence_used: r.evidence_used,
      flags: r.flags,
      needs_human: r.needs_human,
      actions: r.actions.map((a: any) => {
        const { amount, ...rest } = a;
        return { ...rest, amount_ppm: Number((BigInt(amount) * 1_000_000n) / gross) };
      }),
    },
  };
});
writeFileSync(resolve(__dirname, "../replay/proposals.json"), JSON.stringify(rows, null, 2) + "\n");
console.log("wrote", rows.length, "saved proposals");

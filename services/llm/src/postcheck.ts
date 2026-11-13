// Deterministic checks on the model's proposal, run after validation. Defence in depth only: the Policy Service
// stays authoritative. A failed check never removes anything; it adds a flag and sets needs_human, so the Policy
// Service still sees (and can reject) exactly what the model proposed. Checks only ever make the result more cautious.
import type { AgentInput, SettlementProposal } from "./agent.js";
import type { Finding, Truncation } from "./guards.js";

const CANONICAL_AMOUNT = /^(?:0|[1-9][0-9]*)$/;

export interface PostCheckOutcome {
  proposal: SettlementProposal;
  /** Codes of the flags this step added. */
  added: string[];
}

function addFlag(p: SettlementProposal, code: string, detail: string, added: string[]) {
  if (!p.flags.some((f) => f.code === code)) {
    p.flags.push({ code, detail });
    added.push(code);
  }
  p.needs_human = true;
}

/** Guard findings and truncation make the proposal more cautious: flags plus needs_human. */
export function applyGuardFindings(proposal: SettlementProposal, findings: Finding[], truncations: Truncation[]): PostCheckOutcome {
  const p: SettlementProposal = { ...proposal, flags: proposal.flags.map((f) => ({ ...f })), actions: proposal.actions };
  const added: string[] = [];
  if (findings.length > 0) {
    const codes = [...new Set(findings.map((f) => f.code))].join(", ");
    const sources = [...new Set(findings.map((f) => f.source))].join(", ");
    addFlag(p, "INJECTION_SUSPECTED", `Input guard found: ${codes} (in ${sources})`, added);
  }
  if (truncations.length > 0) {
    addFlag(p, "INPUT_TRUNCATED", `Input exceeded size limits: ${truncations.map((t) => `${t.source} (-${t.removedChars} chars)`).join(", ")}`, added);
  }
  return { proposal: p, added };
}

/** Payees, amounts and the gross total. Returns a copy; never changes actions. */
export function postCheck(proposal: SettlementProposal, input: AgentInput): PostCheckOutcome {
  const p: SettlementProposal = { ...proposal, flags: proposal.flags.map((f) => ({ ...f })), actions: proposal.actions };
  const added: string[] = [];
  // The platform fee's payee is set by the system (trusted input), so it counts as listed.
  const listed = new Set([...input.payees.map((x) => x.id), ...(input.platform_fee ? [input.platform_fee.payee_id] : [])]);

  const unlisted = p.actions
    .filter((a) => a.type === "payout" || a.type === "mobile_money_payout")
    .map((a) => String(a.payee_id))
    .filter((id) => !listed.has(id));
  if (unlisted.length > 0) {
    addFlag(p, "UNLISTED_PAYEE", `Proposal pays payee id(s) not in the payee list: ${[...new Set(unlisted)].join(", ").slice(0, 120)}`, added);
  }

  const amounts = p.actions.map((a) => String(a.amount ?? "0"));
  if (amounts.some((a) => !CANONICAL_AMOUNT.test(a))) {
    addFlag(p, "INVALID_AMOUNT", "An action amount is not a canonical integer string of base units", added);
    return { proposal: p, added };
  }

  const total = amounts.reduce((n, a) => n + BigInt(a), 0n);
  const gross = CANONICAL_AMOUNT.test(input.milestone.gross_amount) ? BigInt(input.milestone.gross_amount) : 0n;
  if (total > gross) {
    addFlag(p, "AMOUNT_EXCEEDS_GROSS", `Sum of all actions (${total}) exceeds the gross amount (${gross})`, added);
  }

  const hasPayout = p.actions.some((a) => a.type === "payout" || a.type === "mobile_money_payout");
  if (hasPayout) {
    const tax = p.actions.filter((a) => a.type === "tax_reserve").reduce((n, a) => n + BigInt(String(a.amount)), 0n);
    const required = (gross * BigInt(input.tax_profile.min_tax_reserve_bps) + 9999n) / 10000n;
    if (tax < required) {
      addFlag(p, "TAX_RESERVE_BELOW_MIN", `Tax reserve (${tax}) is below the required minimum (${required})`, added);
    }
  }
  return { proposal: p, added };
}

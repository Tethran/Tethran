// Agent modes. The demo must survive a model rate limit, so the agent can run in three modes:
//   live         call the model through the provider router (Groq first, Gemini fallback)
//   replay       serve a saved proposal for the milestone's scenario; no model call. Labelled "Replay".
//   live+replay  try live; if every live attempt fails (for example HTTP 429), serve the saved proposal and say so
// A replayed proposal is not trusted any more than a live one: it still goes to the Policy Service, which
// decides and signs exactly as it does for a live proposal, and the vault still enforces its limits.
//
// Saved proposals live in replay/proposals.json. Amounts are stored as parts per million of the milestone's
// gross amount, so a saved proposal fits any milestone size; payee ids must exist for the milestone's provider.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentInput, LlmProvider, ProposeResult } from "../../llm/src/index";
import { proposeSettlement } from "../../llm/src/index";

export type AgentMode = "live" | "replay" | "live+replay";

export interface SavedProposal {
  scenario: string;
  source: string; // where it came from, e.g. "groq/openai/gpt-oss-120b eval run 2026-11-12" or "curated"
  proposal: {
    confidence: number;
    evidence_used: string[];
    actions: ({ amount_ppm: number } & Record<string, unknown>)[];
    flags: { code: string; detail: string }[];
    needs_human: boolean;
  };
}

export type AgentRun = ProposeResult & { agent_mode: string; replay_source?: string };

export function parseAgentMode(v: unknown, fallback: AgentMode = "live"): AgentMode {
  if (v === undefined || v === null || v === "") return fallback;
  if (v === "live" || v === "replay" || v === "live+replay") return v;
  throw new Error('agent mode must be "live", "replay" or "live+replay"');
}

export function loadSavedProposals(path = resolve(__dirname, "../replay/proposals.json")): Map<string, SavedProposal> {
  const list = JSON.parse(readFileSync(path, "utf8")) as SavedProposal[];
  return new Map(list.map((p) => [p.scenario, p]));
}

/** Turns a saved proposal into a real one for this milestone. */
export function instantiate(saved: SavedProposal, input: AgentInput): Record<string, unknown> {
  const gross = BigInt(input.milestone.gross_amount);
  return {
    milestone_id: input.milestone.id,
    confidence: saved.proposal.confidence,
    evidence_used: saved.proposal.evidence_used,
    actions: saved.proposal.actions.map(({ amount_ppm, ...rest }) => ({ ...rest, amount: ((gross * BigInt(amount_ppm)) / 1_000_000n).toString() })),
    flags: saved.proposal.flags,
    needs_human: saved.proposal.needs_human,
  };
}

export function createAgent(llm: LlmProvider, saved: Map<string, SavedProposal>) {
  function replay(input: AgentInput, scenario: string, why: string): AgentRun {
    const s = saved.get(scenario) ?? saved.get("clean_delivery");
    if (!s) throw new Error("no saved proposal for scenario " + scenario);
    return {
      ok: true,
      proposal: instantiate(s, input) as never,
      meta: { provider: "replay", model: `saved:${s.scenario}`, latencyMs: 0, attempts: 0, usage: { inputTokens: 0, outputTokens: 0 } },
      agent_mode: why,
      replay_source: s.source,
    };
  }

  return {
    async propose(input: AgentInput, mode: AgentMode, scenario: string): Promise<AgentRun> {
      if (mode === "replay") return replay(input, scenario, "Replay");
      const live = await proposeSettlement(input, llm);
      if (live.ok || mode === "live") return { ...live, agent_mode: "live" };
      const reason = live.attempts.at(-1)?.reason ?? "live call failed";
      return replay(input, scenario, `Replay (live failed: ${reason})`);
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;

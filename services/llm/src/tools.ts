// Tools the Settlement Agent may use (docs/03 section 5.2), as typed functions the orchestrator passes in.
//
// Loop design: SINGLE-SHOT. LlmProvider (INTERFACES section 7) has no tool-calling field, and the three free-tier
// providers do not give uniform, reliable tool-call behaviour. So the orchestrator calls the read tools (and, within
// the spending cap, the paid tools) FIRST through `gatherAgentInput`, and the model gets everything in one request.
// This also keeps the number of model calls at one per run, which matters on free tiers.
//
// There is NO tool that submits or signs a transaction (INTERFACES section 1a). `propose_settlement` is the
// model's reply itself, and `submit_cosigned_tx` is an orchestrator step that never reaches the model.
//
// The paid tools are SIMULATED in this block: they return deterministic demo data and are labelled as such.
// x402 comes later behind the same `PaidDataSource` interface. The spending cap is enforced in code, per run.
import type { AgentInput } from "./agent.js";
import { traceTool } from "./tracing.js";

export const AGENT_TOOL_NAMES = ["get_contract", "get_milestone", "get_evidence", "get_policy_summary", "buy_corridor_rules", "buy_fx_quote"] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export class SpendingCapExceededError extends Error {
  constructor(readonly tool: string, readonly price: bigint, readonly remaining: bigint) {
    super(`spending cap exceeded for ${tool}: price ${price}, remaining ${remaining}`);
    this.name = "SpendingCapExceededError";
  }
}

/** Per-run spending cap in base units of the asset (USDT, 6 decimals). `charge` throws before anything is bought. */
export class SpendingCap {
  private used = 0n;
  constructor(readonly cap: bigint) {
    if (cap < 0n) throw new RangeError("cap must not be negative");
  }
  get spent(): bigint { return this.used; }
  get remaining(): bigint { return this.cap - this.used; }
  charge(tool: string, price: bigint): void {
    if (price < 0n) throw new RangeError("price must not be negative");
    if (price > this.remaining) throw new SpendingCapExceededError(tool, price, this.remaining);
    this.used += price;
  }
}

export interface CorridorRules { corridor: string; min_amount: string; max_amount: string; settlement_days: number; notes: string }
export interface FxQuote { from: string; to: string; rate: string; valid_seconds: number }
export interface PaidResult<T> { simulated: boolean; source: string; price: string; data: T }

/** Where paid data comes from. The x402 implementation will replace SimulatedPaidDataSource. */
export interface PaidDataSource {
  readonly simulated: boolean;
  price(tool: "buy_corridor_rules" | "buy_fx_quote"): bigint;
  corridorRules(corridor: string): Promise<CorridorRules>;
  fxQuote(from: string, to: string): Promise<FxQuote>;
}

/** SIMULATED: deterministic demo data, nothing is bought. */
export class SimulatedPaidDataSource implements PaidDataSource {
  readonly simulated = true;
  constructor(private readonly prices: { corridor_rules?: bigint; fx_quote?: bigint } = {}) {}
  price(tool: "buy_corridor_rules" | "buy_fx_quote"): bigint {
    return tool === "buy_corridor_rules" ? this.prices.corridor_rules ?? 20_000n : this.prices.fx_quote ?? 10_000n; // 0.02 and 0.01 USDT
  }
  async corridorRules(corridor: string): Promise<CorridorRules> {
    return { corridor, min_amount: "1000000", max_amount: "1500000000", settlement_days: 1, notes: "SIMULATED demo corridor rules" };
  }
  async fxQuote(from: string, to: string): Promise<FxQuote> {
    return { from, to, rate: "1.000000", valid_seconds: 60 };
  }
}

export interface ReadSources {
  getContract(milestoneId: string): Promise<string> | string;
  getMilestone(milestoneId: string): Promise<AgentInput["milestone"]> | AgentInput["milestone"];
  getEvidence(milestoneId: string): Promise<AgentInput["evidence"]> | AgentInput["evidence"];
  getPolicySummary(): Promise<AgentInput["policy_summary"]> | AgentInput["policy_summary"];
}

export interface AgentTools {
  readonly names: readonly AgentToolName[];
  readonly cap: SpendingCap;
  get_contract(milestoneId: string): Promise<string>;
  get_milestone(milestoneId: string): Promise<AgentInput["milestone"]>;
  get_evidence(milestoneId: string): Promise<AgentInput["evidence"]>;
  get_policy_summary(): Promise<AgentInput["policy_summary"]>;
  buy_corridor_rules(corridor: string): Promise<PaidResult<CorridorRules>>;
  buy_fx_quote(from: string, to: string): Promise<PaidResult<FxQuote>>;
}

export interface CreateToolsOptions {
  read: ReadSources;
  paid: PaidDataSource;
  /** Maximum total price of paid calls in one run, in base units. Enforced in code. */
  spendingCapBaseUnits: bigint;
}

export function createAgentTools(opts: CreateToolsOptions): AgentTools {
  const cap = new SpendingCap(opts.spendingCapBaseUnits);
  const paid = opts.paid;
  const label = paid.simulated ? "SIMULATED_X402_DEMO" : "x402";
  return {
    names: AGENT_TOOL_NAMES,
    cap,
    get_contract: async (id) => traceTool("get_contract", { input: { milestone_id: id }, output: (c: string) => ({ chars: c.length }) }, async () => opts.read.getContract(id)),
    get_milestone: async (id) => traceTool("get_milestone", { input: { milestone_id: id }, output: (m) => ({ status: m.status }) }, async () => opts.read.getMilestone(id)),
    get_evidence: async (id) => traceTool("get_evidence", { input: { milestone_id: id }, output: (e) => ({ items: e.length }) }, async () => opts.read.getEvidence(id)),
    get_policy_summary: async () => traceTool("get_policy_summary", { output: () => ({ ok: true }) }, async () => opts.read.getPolicySummary()),
    buy_corridor_rules: async (corridor) =>
      traceTool("buy_corridor_rules", { input: { corridor, simulated: paid.simulated }, output: (r) => ({ price: r.price, simulated: r.simulated, spent: String(cap.spent) }) }, async () => {
        const price = paid.price("buy_corridor_rules");
        cap.charge("buy_corridor_rules", price); // throws before anything is bought
        return { simulated: paid.simulated, source: label, price: String(price), data: await paid.corridorRules(corridor) };
      }),
    buy_fx_quote: async (from, to) =>
      traceTool("buy_fx_quote", { input: { from, to, simulated: paid.simulated }, output: (r) => ({ price: r.price, simulated: r.simulated, spent: String(cap.spent) }) }, async () => {
        const price = paid.price("buy_fx_quote");
        cap.charge("buy_fx_quote", price);
        return { simulated: paid.simulated, source: label, price: String(price), data: await paid.fxQuote(from, to) };
      }),
  };
}

export interface GatherOptions {
  milestoneId: string;
  payees: AgentInput["payees"];
  tax_profile: AgentInput["tax_profile"];
  /** Paid data to buy before the model call, within the cap. A purchase over the cap is skipped, not fatal. */
  buy?: { corridor?: string; fx?: { from: string; to: string } };
}

/** Calls the read tools (and optional paid tools) and assembles the AgentInput for `proposeSettlement`. */
export async function gatherAgentInput(tools: AgentTools, o: GatherOptions): Promise<AgentInput> {
  const [milestone, contract_text, evidence, policy_summary] = await Promise.all([
    tools.get_milestone(o.milestoneId),
    tools.get_contract(o.milestoneId),
    tools.get_evidence(o.milestoneId),
    tools.get_policy_summary(),
  ]);
  const paid_data: NonNullable<AgentInput["paid_data"]> = [];
  const attempt = async (fn: () => Promise<PaidResult<unknown>>, tool: string) => {
    try {
      const r = await fn();
      paid_data.push({ tool, simulated: r.simulated, data: r.data });
    } catch (e) {
      if (!(e instanceof SpendingCapExceededError)) throw e; // over the cap: continue without this data
    }
  };
  if (o.buy?.corridor) await attempt(() => tools.buy_corridor_rules(o.buy!.corridor!), "buy_corridor_rules");
  if (o.buy?.fx) await attempt(() => tools.buy_fx_quote(o.buy!.fx!.from, o.buy!.fx!.to), "buy_fx_quote");
  return {
    milestone, payees: o.payees, policy_summary, tax_profile: o.tax_profile, contract_text, evidence,
    ...(paid_data.length > 0 ? { paid_data } : {}),
  };
}

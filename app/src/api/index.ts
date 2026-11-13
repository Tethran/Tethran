// The single API boundary. Screens import only from here. Every call goes to the Tethran backend (docs/API.md);
// responses are mapped into the screen types in ./types. Anything the backend labels simulated stays labelled.
import { ApiError, API_BASE, centsToDollars, dollars, get, post } from "./http";
import { POLICY_ESCALATE_CODES, POLICY_REJECT_CODES } from "./reasons";
import { demoSetLimits, demoSettle, demoSignerInfo, signAs, type Via } from "./wallet";
import { externalWallet } from "@/wallet/external";
export { DEMO_LABEL, type Via } from "./wallet";
import type {
  ApprovalItem, AuditEntry, Contract, Country, Decision, Dispute, IdentityHold, Invoice, Limits, Milestone, MilestoneStatus,
  Earnings, Proposal, Receipt, ReconRow, WalletActivity, WalletReview,
} from "./types";

export { ApiError, API_BASE } from "./http";
export { reasonInfo } from "./reasons";

/** The demo provider (the seed creates it). */
export const PROVIDER_ID = "prov-demo";

// ---------- mapping ----------

const STATUS: Record<string, MilestoneStatus> = {
  draft: "Draft", funded: "Funded", in_review: "In review", approved: "Approved", disputed: "Disputed",
  released: "Released", paid_out: "Paid out", refunded: "Refunded",
};
const statusOf = (s: string | null | undefined): MilestoneStatus => STATUS[s ?? "draft"] ?? "Draft";

function decisionOf(d: string): Decision {
  if (d === "approved" || d === "paid_out") return "APPROVED";
  if (d === "escalated") return "ESCALATED";
  return "REJECTED"; // rejected, new_plan_requested
}

const COUNTRIES: Country[] = ["NG", "KE", "ZA", "GH"];
const countryOf = (c: unknown): Country | null => (COUNTRIES as string[]).includes(String(c)) ? (c as Country) : null;

const methodOfRail = (rail: string): "phone" | "bank" | "wallet" =>
  rail === "bank" ? "bank" : rail === "usdt" || rail === "evm" ? "wallet" : "phone";

type PayeeInfo = { payee_id: string; name: string; rail: string; simulated: boolean };
type ProviderInfo = { provider_id: string; chain_id: number; vault: string; operator: string; provider_address: string; payees: PayeeInfo[] };

let providerCache: Promise<ProviderInfo> | undefined;
const provider = () => (providerCache ??= get<ProviderInfo>(`/providers/${PROVIDER_ID}`).catch((e) => { providerCache = undefined; throw e; }));

const isPayout = (a: any) => a?.type === "payout" || a?.type === "mobile_money_payout";

/** Base64 of a File (for the JSON upload). */
async function toBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** The reserved payee of Tethran's earnings account (the 5% platform fee line). */
export const EARNINGS_ID = "tethran_earnings";

/** A plain-language summary of the agent's plan, built from its actions (the agent's own text is not shown). */
function summarize(actions: any[], payees: PayeeInfo[]): string {
  const name = (id: string) => payees.find((p) => p.payee_id === id)?.name ?? id;
  const fee = actions.filter((a) => isPayout(a) && a.payee_id === EARNINGS_ID).reduce((n, a) => n + dollars(a.amount), 0);
  const pays = actions.filter((a) => isPayout(a) && a.payee_id !== EARNINGS_ID).map((a) => `$${dollars(a.amount).toLocaleString("en-US")} to ${name(a.payee_id)}`);
  const feeText = fee > 0 ? `; Tethran's 5% platform fee $${fee.toLocaleString("en-US")}` : "";
  const tax = actions.filter((a) => a?.type === "tax_reserve").reduce((n, a) => n + dollars(a.amount), 0);
  if (pays.length === 0) return tax > 0 ? `Pays nobody. Sets aside $${tax.toLocaleString("en-US")} for tax.` : "Pays nobody.";
  return `Pays ${pays.join(" and ")}${tax > 0 ? `; sets aside $${tax.toLocaleString("en-US")} for tax` : ""}${feeText}.`;
}

function proposalFrom(raw: any, meta: { id: string; milestoneId: string; decision: string; reasons: string[]; traceId?: string | null; agentMode?: string | null; approvalId?: string | null; at: string }, payees: PayeeInfo[]): Proposal {
  const actions: any[] = Array.isArray(raw?.actions) ? raw.actions : [];
  return {
    id: meta.id,
    milestoneId: meta.milestoneId,
    summary: raw ? summarize(actions, payees) : "The agent produced no valid plan.",
    payouts: actions.filter(isPayout).map((a) => {
      const p = payees.find((x) => x.payee_id === a.payee_id);
      return { to: p?.name ?? a.payee_id, method: methodOfRail(p?.rail ?? "usdt"), amount: dollars(a.amount) };
    }),
    decision: decisionOf(meta.decision),
    reasons: meta.reasons ?? [],
    flags: Array.isArray(raw?.flags) ? raw.flags : [],
    needsHuman: raw?.needs_human === true,
    confidence: typeof raw?.confidence === "number" ? raw.confidence : null,
    agentMode: meta.agentMode ?? null,
    traceId: meta.traceId ?? null,
    approvalId: meta.approvalId ?? null,
    createdAt: meta.at,
  };
}

// ---------- demo wallet (Tethran wallet) ----------

/** The demo's people, each with one Tethran wallet (a WDK wallet from the demo seed). */
export const WALLET_USERS = [
  { role: "client", name: "Kofi Mensah Ltd", as: "client" },
  { role: "payee_amara", name: "Amara Studio", as: "freelancer" },
] as const;
export type WalletUser = (typeof WALLET_USERS)[number]["role"];

/** The wallet (role) that is a milestone's client (it pays, approves and votes); null when it is a connected wallet. */
async function payerRole(milestoneId: string): Promise<string | null> {
  const [m, w] = await Promise.all([get<any>(`/milestones/${milestoneId}`), get<any>("/wallets")]);
  const hit = (w.wallets as any[]).find((x) => String(x.address).toLowerCase() === String(m.client_address).toLowerCase());
  return hit?.role ?? null;
}
const needRole = async (milestoneId: string): Promise<string> => {
  const r = await payerRole(milestoneId);
  if (!r) throw new ApiError("CONNECTED_WALLET_CLIENT", "This milestone's client is a connected wallet: use Connected wallet.");
  return r;
};

/** Sends a backend-built call from the connected wallet and waits until it is mined. */
async function sendFromConnectedWallet(call: { to: string; data: string; value: string }): Promise<string> {
  const from = externalWallet.state.address;
  if (!from) throw new ApiError("WALLET_NOT_CONNECTED", "Connect the wallet that is this contract's client.");
  const hash = (await externalWallet.request("eth_sendTransaction", [{ from, to: call.to, data: call.data, value: call.value }])) as string;
  for (let i = 0; i < 90; i++) {
    const r = (await externalWallet.request("eth_getTransactionReceipt", [hash]).catch(() => null)) as { status?: string } | null;
    if (r) { if (r.status !== "0x1") throw new ApiError("TX_FAILED", "The transaction failed on-chain."); return hash; }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return hash;
}

const payoutTotal = (raw: any) => (Array.isArray(raw?.actions) ? raw.actions : []).filter(isPayout)
  .reduce((n: bigint, a: any) => n + BigInt(String(a.amount ?? "0")), 0n);

const networkName = (chainId: number) => chainId === 11155111 ? "Sepolia (test network)" : chainId === 84532 ? "Base Sepolia (test network)" : chainId === 31337 ? "Local test chain" : `Test chain ${chainId}`;

// ---------- contracts and milestones ----------

async function contracts(): Promise<Contract[]> {
  const [{ contracts: cs }, { milestones: live }, { invoices }] = await Promise.all([
    get<{ contracts: any[] }>("/contracts"),
    get<{ milestones: any[] }>("/milestones"),
    get<{ invoices: any[] }>("/invoices"),
  ]);
  const escrow = new Map(live.map((m) => [m.id, m]));
  return cs.map((c) => ({
    id: c.id,
    title: c.milestones?.[0]?.title ? `${c.client_name}: ${c.milestones[0].title}${c.milestones.length > 1 ? ` and ${c.milestones.length - 1} more` : ""}` : c.client_name,
    provider: c.provider_name ?? c.provider_id,
    client: c.client_name,
    country: countryOf(c.country),
    createdAt: String(c.created_at ?? "").slice(0, 10),
    status: c.status,
    milestones: (c.milestones ?? []).map((m: any): Milestone => {
      const e = escrow.get(m.id);
      const inv = invoices.find((i) => i.milestone_id === m.id && i.occurrence === 0);
      return {
        id: m.id, contractId: c.id, title: m.title, amount: centsToDollars(m.amount_usd_cents),
        fee: inv ? centsToDollars(inv.fee_cents) : 0, status: statusOf(e?.state ?? m.state), criteria: m.acceptance_criteria,
        dueDate: m.due_date, live: Boolean(e), escrowTx: e?.escrow_tx ?? null, releaseTx: e?.release_tx ?? null,
      };
    }),
  }));
}

async function milestoneDetail(id: string) {
  const all = await contracts();
  const contract = all.find((c) => c.milestones.some((m) => m.id === id));
  if (!contract) return null;
  const base = contract.milestones.find((m) => m.id === id)!;
  if (!base.live) return { milestone: base, contract, proposal: null as Proposal | null, history: [] as Proposal[] };
  const [t, prov] = await Promise.all([get<any>(`/milestones/${id}/timeline`), provider()]);
  const m = t.milestone;
  const funding = (t.fundings ?? [])[0];
  const holdEnds = m.card_funded && m.hold_seconds && funding?.at ? new Date(Date.parse(funding.at) + m.hold_seconds * 1000).toISOString() : undefined;
  const history: Proposal[] = (t.settlement_plans ?? []).map((p: any) => proposalFrom(p.proposal, {
    id: String(p.id), milestoneId: id, decision: p.decision, reasons: p.reasons, traceId: p.trace_id, agentMode: p.agent_mode, approvalId: p.approval_id, at: p.at,
  }, prov.payees));
  const milestone: Milestone = {
    ...base, status: statusOf(m.state), escrowTx: m.escrow_tx, releaseTx: m.release_tx,
    evidence: (t.evidence ?? []).map((e: any) => ({
      id: e.id, note: e.text ?? "", link: e.link ?? null, at: e.at,
      files: (e.files ?? []).map((f: any) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, sha256: f.sha256, url: `${API_BASE}${f.download}` })),
    })),
    deliveryCheck: t.delivery_check ? { checks: t.delivery_check.checks ?? [], agentMode: t.delivery_check.agent_mode ?? null, error: t.delivery_check.error ?? null, at: t.delivery_check.at ?? null } : null,
    ...(holdEnds ? { cardHoldEndsAt: holdEnds } : {}),
    payouts: (t.payouts ?? []).map((p: any) => ({
      to: p.payee_id === EARNINGS_ID ? "Tethran earnings account" : prov.payees.find((x) => x.payee_id === p.payee_id)?.name ?? p.payee_id, amount: dollars(p.amount), rail: String(p.rail ?? "usdt"),
      platformFee: p.payee_id === EARNINGS_ID,
      ...(p.offchain ? { local: { amount: String(p.offchain.local_amount), currency: String(p.offchain.currency), rateLabel: String(p.offchain.fx_label ?? ""), attribution: p.offchain.fx_attribution ?? null } } : {}),
      simulated: p.simulated === 1 || p.simulated === true, tx: p.tx ?? null, status: String(p.status ?? ""),
    })),
  };
  return { milestone, contract, proposal: history.at(-1) ?? null, history };
}

// ---------- invoices and funding ----------

function invoiceFrom(i: any): Invoice {
  const tax = Object.entries(i.provider_tax_ids ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  return {
    id: i.id, contractId: i.contract_id, milestoneId: i.escrow_milestone_id ?? i.milestone_id, number: i.number,
    amount: centsToDollars(i.subtotal_cents), fee: centsToDollars(i.fee_cents), feePaidBy: i.fee_payer === "client" ? "client" : "provider",
    status: i.status === "paid" ? "Paid" : "Unpaid", payLink: i.pay_url, issuedAt: i.issue_date, ...(tax ? { taxId: tax } : {}),
    provider: i.provider_name, client: i.client_name, title: i.line_items?.[0]?.description ?? i.number,
  };
}

const CHECKOUT_METHOD: Record<string, string> = { card: "card", apple: "apple_pay", google: "google_pay", paypal: "paypal", cashapp: "cashapp", coin: "stablecoin" };

async function waitTransfer(ref: string) {
  for (let i = 0; i < 100; i++) {
    const st = await get<any>(`/wallets/transfers/${encodeURIComponent(ref)}`);
    if (st.status === "confirmed") return st;
    if (st.status === "failed") throw new ApiError("SEND_FAILED", "The transfer failed on the network. Nothing was taken twice; you can try again.");
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new ApiError("PENDING", "Still waiting for the network. Check again later; it will not be sent twice.");
}

// ---------- the API ----------

export const api = {
  listContracts: contracts,
  getContract: async (id: string) => (await contracts()).find((c) => c.id === id) ?? null,
  getMilestone: milestoneDetail,

  /** The client's own on-chain action, signed by the WDK wallet that is this milestone's client (demo custody). */
  setMilestoneStatus: async (id: string, status: MilestoneStatus) => {
    if (status !== "Approved" && status !== "Disputed") throw new ApiError("UNSUPPORTED", "Only approve or dispute can be done here.");
    const role = await payerRole(id);
    if (!role) {
      // The client is a connected wallet: it sends the escrow approve itself.
      if (status !== "Approved") throw new ApiError("NOT_AVAILABLE", "Opening a dispute from a connected wallet is not available yet.");
      return { tx_hash: await sendFromConnectedWallet(await api.approveCall(id)) };
    }
    return post<{ tx_hash: string }>(`/wallets/${role}/escrow/${id}/${status === "Approved" ? "approve" : "dispute"}`);
  },
  /**
   * Submits delivery: a note, a link and up to 5 files (10 MB each; txt, md, csv, json, pdf, png, jpg, webp, gif, zip).
   * Files go as base64 in JSON. The backend runs the agent's advisory delivery check and returns it.
   */
  addEvidence: async (id: string, input: { note?: string; link?: string; files?: File[] }) => {
    const files = await Promise.all((input.files ?? []).map(async (f) => ({ name: f.name, mime: f.type, content_base64: await toBase64(f) })));
    return post<{ evidence_id: number; delivery_check: any }>(`/milestones/${id}/evidence`, {
      ...(input.note ? { text: input.note } : {}), ...(input.link ? { link: input.link } : {}), ...(files.length ? { files } : {}),
    });
  },
  /** Advisory evidence summary (a live model call; it never decides). Returned as plain text. */
  evidenceSummary: async (id: string): Promise<string> => {
    const r = await post<any>(`/milestones/${id}/evidence/summary`);
    const s = r?.summary ?? {};
    const list = (label: string, xs: unknown) => (Array.isArray(xs) && xs.length ? `
${label}: ${xs.join("; ")}` : "");
    return `${s.summary ?? "No summary."}${list("Supports", s.supporting)}${list("Against", s.against)}${list("Missing", s.missing)}`;
  },

  listInvoices: async () => (await get<{ invoices: any[] }>("/invoices")).invoices.map(invoiceFrom),
  getInvoice: async (id: string) => {
    try { return invoiceFrom(await get<any>(`/invoices/${id}`)); } catch (e) { if ((e as ApiError).status === 404) return null; throw e; }
  },
  /**
   * Pays an invoice. Card, Apple Pay, Google Pay, PayPal and Cash App go through the SIMULATED checkout (signed
   * events through the real webhook handler). "Tethran wallet" pays test USDT from the payer's demo wallet (the WDK
   * wallet that is the milestone's client) after the review checks: the stablecoin-deposit path.
   */
  payInvoice: async (id: string, method = "card") => {
    const inv = await get<any>(`/invoices/${id}`);
    const milestoneId = inv.escrow_milestone_id;
    if ((CHECKOUT_METHOD[method] ?? "card") === "stablecoin") {
      const role = await needRole(milestoneId);
      const dep = await get<any>(`/milestones/${milestoneId}/deposit`);
      const transfer = { to: dep.deposit_address, amount: dep.amount, chain_id: dep.chain_id, payment_reference: `deposit:${milestoneId}` };
      const review = await post<any>(`/wallets/${role}/transfers/review`, transfer);
      if (!review.can_sign) {
        const b = review.blocked?.[0];
        throw new ApiError(b?.code ?? "BLOCKED", b?.code === "INSUFFICIENT_BALANCE" ? "Not enough in your Tethran wallet. Add funds, or pay by card." : "The payment can't be signed yet.");
      }
      const sent = await post<any>(`/wallets/${role}/transfers`, transfer);
      await waitTransfer(transfer.payment_reference);
      await post(`/milestones/${milestoneId}/deposit/confirm`, { tx_hash: sent.tx_hash });
      return { paymentId: sent.tx_hash as string, simulated: false };
    }
    const s = await post<any>("/checkout/sessions", { milestone_id: milestoneId, method: CHECKOUT_METHOD[method] ?? "card" });
    // SIMULATED checkout: the client completes the payment ("paid"); the backend signs the event into its webhook.
    await post(`/checkout/sessions/${s.session_id}/complete`, { outcome: "paid" });
    return { paymentId: s.session_id as string, simulated: true };
  },

  listReceipts: async (): Promise<Receipt[]> => {
    const [{ milestones }, cs] = await Promise.all([get<{ milestones: any[] }>("/milestones?state=paid_out"), contracts()]);
    const out = await Promise.all(milestones.map((m) => api.getReceipt(m.id, cs).catch(() => null)));
    return out.filter((r): r is Receipt => r !== null);
  },
  getReceipt: async (id: string, cs?: Contract[]): Promise<Receipt | null> => {
    let r: any;
    try { r = await get<any>(`/receipts/${id}`); } catch (e) { if ((e as ApiError).status === 404) return null; throw e; }
    const title = (cs ?? await contracts()).flatMap((c) => c.milestones).find((m) => m.id === id)?.title ?? "Milestone";
    const ledger = await get<any>(`/reconciliation/milestones/${id}`).catch(() => null);
    return {
      id, milestoneId: id, milestoneTitle: title, amount: dollars(r.amount), date: new Date(r.mintedAt * 1000).toISOString().slice(0, 10),
      tokenId: `#${String(r.tokenId).padStart(4, "0")}`, contentHash: r.settlementHash, txHash: r.releaseTx, network: networkName(r.chainId), holder: r.holder,
      ...(ledger?.totals?.platform_fee ? { platformFee: dollars(ledger.totals.platform_fee) } : {}),
    };
  },
  /** Reads the receipt from the chain again and checks it belongs to this milestone. */
  verifyReceipt: async (id: string) => {
    try { const r = await get<any>(`/receipts/${id}`); return { valid: r.verified_on_chain === true && r.tokenId > 0 }; } catch { return { valid: false }; }
  },

  listRecon: async (): Promise<ReconRow[]> => {
    const list = await get<{ items: any[] }>("/reconciliation");
    return Promise.all(list.items.map(async (it) => {
      const l = await get<any>(`/reconciliation/milestones/${it.milestone_id}`);
      return {
        id: it.milestone_id, invoice: it.invoice_number, amount: dollars(it.gross), country: countryOf(it.country),
        payment: l.payment?.fundings?.[0]?.reference ? String(l.payment.fundings[0].reference).slice(0, 14) : null,
        escrow: l.escrow_tx ? String(l.escrow_tx).slice(0, 12) : null,
        payout: (l.payouts ?? []).find((p: any) => p.tx)?.tx?.slice(0, 12) ?? null,
        receipt: l.receipt?.token_id ? `#${l.receipt.token_id}` : null,
        platformFee: dollars(l.totals?.platform_fee ?? "0"),
        complete: it.complete, gaps: it.gaps ?? [],
      };
    }));
  },
  /** Get test USDT: 100 test USDT minted to a connected wallet (DEMO_MODE only; gas needs Sepolia ETH). */
  getTestUsdt: (address: string) => post<{ tx_hash: string; note: string }>("/wallets/external/mint", { address }),
  /** The deposit and approve transactions a connected wallet sends itself. */
  depositCall: (milestoneId: string) => get<any>(`/milestones/${milestoneId}/calls/deposit`),
  approveCall: (milestoneId: string) => get<{ to: string; data: string; value: string; chain_id: number }>(`/milestones/${milestoneId}/calls/approve`),
  confirmDeposit: (milestoneId: string, txHash: string) => post(`/milestones/${milestoneId}/deposit/confirm`, { tx_hash: txHash }),
  /** The Emails view: every invoice email (status, provider message id, time). */
  emails: async () => {
    const e = await get<any>("/emails");
    return {
      configured: e.configured === true, provider: e.provider ?? null, dailyCap: e.daily_cap ?? 0, sentToday: e.sent_today ?? 0,
      items: (e.items as any[]).map((m) => ({ id: m.id as number, to: String(m.to), subject: String(m.subject), status: String(m.status), providerMessageId: m.provider_message_id ?? null, error: m.error ?? null, createdAt: String(m.created_at), attempts: Number(m.attempts ?? 0), invoiceId: m.invoice_id ?? null, payUrl: typeof m.body_text === "string" ? (m.body_text.match(/Pay it here: (S+)/)?.[1] ?? null) : null })),
    };
  },
  /** Send a failed invoice email again (in the background; the list shows sending, then sent or failed). */
  retryEmail: (id: number) => post(`/emails/${id}/retry`),
  /** A role's notifications (newest first) and its unread count. */
  notifications: (role: string) => get<{ unread: number; items: { id: number; type: string; title: string; body: string; link: string; created_at: string; read_at: string | null }[] }>(`/notifications?recipient=${encodeURIComponent(role)}`),
  markNotificationRead: (id: number, role: string) => post(`/notifications/${id}/read`, { recipient: role }),
  markAllNotificationsRead: (role: string) => post("/notifications/read-all", { recipient: role }),
  /** Tethran earnings (operator): fee lines, total collected, the demo earnings account and its balance. */
  earnings: async (): Promise<Earnings> => {
    const e = await get<any>("/earnings");
    return {
      label: e.label, address: e.account?.address ?? null, balance: e.account?.balance == null ? null : dollars(e.account.balance),
      totalCollected: dollars(e.total_collected),
      lines: (e.lines as any[]).map((l) => ({ milestoneId: l.milestone_id, title: l.title ?? "Milestone", gross: dollars(l.gross ?? "0"), fee: dollars(l.fee), tx: l.tx ?? null, status: l.status, at: l.at })),
    };
  },
  /** The backend's tax export (country from the contract's profile; refuses rows without one). */
  reconCsvUrl: () => `${API_BASE}/reconciliation/export.csv`,

  listApprovals: async (): Promise<ApprovalItem[]> => {
    const [q, prov] = await Promise.all([get<any>("/operator/queue"), provider()]);
    const rows: any[] = Array.isArray(q.policy_approvals) ? q.policy_approvals : [];
    return rows.map((a) => {
      const p = proposalFrom(a.proposal, { id: a.id, milestoneId: a.milestone_id, decision: "escalated", reasons: a.reasons, traceId: a.trace_id, approvalId: a.id, at: a.created_at }, prov.payees);
      const total = payoutTotal(a.proposal);
      return {
        id: a.id, milestoneId: a.milestone_id, proposal: p, amount: dollars(total.toString()),
        payee: p.payouts.map((x) => x.to).join(", "), createdAt: a.created_at,
        movesNoMoney: total === 0n || (a.reasons ?? []).includes("NO_PAYOUTS"),
      };
    });
  },
  listIdentityHolds: async (): Promise<IdentityHold[]> => {
    const q = await get<any>("/operator/queue");
    return (q.identity_holds ?? []).filter((h: any) => h.status === "open")
      .map((h: any) => ({ milestoneId: h.milestone_id, reason: h.reason, status: h.status, openedAt: h.opened_at }));
  },
  /**
   * The vault operator decides an escalated plan: approve, reject, or request a new plan. The operator signs with their
   * own wallet; the Policy Service checks the signature. A plan that moves no money cannot be approved.
   */
  decideApproval: async (item: ApprovalItem, decision: "approve" | "reject" | "new_plan", via: Via = "wallet") => {
    if (decision === "approve" && item.movesNoMoney) throw new ApiError("NO_PAYOUTS", "This plan pays nobody. Request a new plan or reject it.");
    const typed = await get<any>(`/operator/approvals/${item.id}/typed-data?decision=${decision}`);
    const { signature } = await signAs("operator", typed, via);
    return post<any>(`/milestones/${item.milestoneId}/escalations/${item.id}/execute`, { decision, operator_signature: signature });
  },
  decideIdentity: async (milestoneId: string, decision: "release" | "hold", via: Via = "wallet") => {
    const typed = await get<any>(`/operator/identity-holds/${milestoneId}/typed-data?decision=${decision}`);
    const { signature } = await signAs("operator", typed, via);
    return post<any>(`/operator/identity-holds/${milestoneId}/decision`, { decision, operator_signature: signature });
  },
  listAudit: async (): Promise<AuditEntry[]> => {
    const raw = await get<any>("/operator/audit");
    const rows: any[] = Array.isArray(raw) ? raw : raw?.entries ?? raw?.rows ?? [];
    return rows.slice().reverse().map((r, k) => ({
      id: `${r.at}-${k}`, at: String(r.at ?? "").slice(11, 16), actor: "Policy Service",
      action: `${String(r.decision ?? "").replace(/^./, (c: string) => c.toUpperCase())} the plan for milestone ${String(r.milestone_id ?? "").slice(0, 8)} (policy v${r.policy_version ?? "?"})`,
      reasons: r.reasons ?? [],
    }));
  },
  getLimits: async (): Promise<Limits> => {
    const [{ policy, version }, prov] = await Promise.all([get<any>("/operator/policy"), provider()]);
    return {
      perPayment: dollars(policy.per_tx_cap), softLimit: dollars(policy.per_tx_soft_limit), daily: dollars(policy.daily_cap),
      taxReservePercent: policy.min_tax_reserve_bps / 100, confidenceThreshold: policy.confidence_threshold, version,
      approvedPayees: (policy.payee_allowlist ?? []).map((id: string) => prov.payees.find((p) => p.payee_id === id)?.name ?? id),
    };
  },

  listDisputes: async (): Promise<Dispute[]> => (await get<any[]>("/arbiter/disputes")).map((d) => ({
    milestoneId: d.milestone_id, title: d.title, amount: dollars(d.amount), timeout: d.timeout,
    attestations: (d.attestations ?? []).map((a: any) => ({ signer: a.signer, kind: a.kind, releaseToProvider: a.release_to_provider === 1 || a.release_to_provider === true, at: a.at })),
  })),
  /** The arbiter's vote, signed with the arbiter's own wallet. Two matching votes settle the escrow on-chain. */
  arbiterVote: async (milestoneId: string, release: boolean, via: Via = "wallet") => {
    const typed = await get<any>(`/arbiter/disputes/${milestoneId}/typed-data?kind=arbiter&release_to_provider=${release}`);
    const { signer, signature } = await signAs("arbiter", typed, via);
    return post<any>(`/arbiter/disputes/${milestoneId}/attestations`, { signer, signature, release_to_provider: release });
  },

  /** Creates and signs a contract: the provider signs with their own wallet, the client with its WDK wallet. */
  /**
   * clientWallet: which demo wallet is the contract's client and pays it. "client" is Kofi Mensah Ltd; "payee_amara"
   * is the freelancer's own Tethran wallet (one person can be a freelancer and a client).
   */
  createContract: async (input: { clientName: string; clientEmail: string; country: Country; milestones: { title: string; amountUsd: number; criteria: string }[]; clientWallet?: WalletUser | "external" }, via: Via = "wallet") => {
    const clientRole = input.clientWallet ?? "client";
    const [prov, wallets] = await Promise.all([provider(), get<any>("/wallets")]);
    // "external": the connected wallet is the client; it signs the contract itself.
    const client = clientRole === "external" ? externalWallet.state.address : wallets.wallets.find((w: any) => w.role === clientRole)?.address;
    if (!client) throw new ApiError("NO_CLIENT_WALLET", "The demo client wallet is not configured.");
    const due = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
    const c = await post<any>("/contracts", {
      provider_id: PROVIDER_ID, provider_address: prov.provider_address, client_address: client,
      client_name: input.clientName, client_email: input.clientEmail, currency: "USD", country: input.country,
      milestones: input.milestones.map((m) => ({ title: m.title, amount_usd_cents: Math.round(m.amountUsd * 100), acceptance_criteria: m.criteria || m.title, due_date: due })),
    });
    const typed = await get<any>(`/contracts/${c.id}/typed-data?party=provider`);
    const { signer, signature } = await signAs("provider", typed, via);
    await post(`/contracts/${c.id}/sign`, { party: "provider", signer, signature });
    if (clientRole === "external") {
      const ct = await get<any>(`/contracts/${c.id}/typed-data?party=client`);
      const s = await signAs("provider", ct, "wallet"); // the connected wallet signs as the client (signTyped prefers it)
      await post(`/contracts/${c.id}/sign`, { party: "client", signer: s.signer, signature: s.signature });
    } else {
      await post(`/wallets/${clientRole}/contracts/${c.id}/sign`);
    }
    let firstInvoice: string | null = null;
    for (const m of (await get<any>(`/contracts/${c.id}/milestones`)).milestones) {
      const body = await post<any>(`/contracts/${c.id}/milestones/${m.id}/activate`);
      await post("/milestones", body);
      firstInvoice ??= (await get<any>(`/contracts/${c.id}/milestones`)).milestones.find((x: any) => x.id === m.id)?.invoice_id ?? null;
    }
    return { contractId: c.id as string, invoiceId: firstInvoice };
  },

  /** The client's own dispute vote (2-of-3), signed by the WDK wallet that is this milestone's client (demo custody). */
  clientVote: async (milestoneId: string, release: boolean) => {
    const a = await post<any>(`/wallets/${await needRole(milestoneId)}/attestations/${milestoneId}`, { kind: "client", release_to_provider: release });
    return post<any>(`/arbiter/disputes/${milestoneId}/attestations`, { signer: a.signer, signature: a.signature, release_to_provider: release });
  },

  /** DEMO MODE: is the one-click demo signer running? (null when not; then only the wallet path is shown) */
  demoSigner: demoSignerInfo,
  /**
   * DEMO MODE: the platform's own step after the client approves: release the escrow to the vault, then settle (the
   * agent proposes, the Policy Service decides, the vault pays, the receipt is minted). Run by the presenter's process
   * with the platform token; the browser never holds it.
   */
  demoSettle: demoSettle,
  /**
   * The operator changes the spending limits (dollars). DEMO MODE only: signed with the operator's test key and relayed
   * to the vault by the Policy Service. (With a real wallet the operator would sign the same two messages.)
   */
  setLimits: async (l: { perPayment: number; softLimit?: number; daily?: number }) => {
    const base = (usd: number) => (BigInt(Math.round(usd * 100)) * 10_000n).toString();
    return demoSetLimits({
      per_tx_cap: base(l.perPayment),
      ...(l.softLimit !== undefined ? { per_tx_soft_limit: base(l.softLimit) } : {}),
      ...(l.daily !== undefined ? { daily_cap: base(l.daily) } : {}),
    });
  },
  /** Asks the vault contract whether it would pay this amount (dollars) to this payee right now. */
  vaultCheck: async (payeeId: string, usd: number) => {
    const amount = (BigInt(Math.round(usd * 100)) * 10_000n).toString();
    const r = await get<any>(`/operator/vault-check?payee_id=${encodeURIComponent(payeeId)}&amount=${amount}`);
    return { ok: r.ok as boolean, reason: String(r.reason ?? ""), perTxCap: dollars(r.per_tx_cap), policyVersion: r.policy_version as number };
  },

  /** Wallet review and send (the client's WDK wallet). Nothing is signed by review. */
  wallets: () => get<any>("/wallets"),
  reviewTransfer: async (t: { to: string; amount: string; chainId: number; reference: string }): Promise<WalletReview> => {
    const r = await post<any>("/wallets/client/transfers/review", { to: t.to, amount: t.amount, chain_id: t.chainId, payment_reference: t.reference });
    return {
      from: r.from, recipient: { address: r.recipient?.address, savedName: r.recipient?.saved_name ?? null },
      network: { name: r.network?.name, chainId: r.network?.chain_id }, amount: dollars(r.amount?.base_units),
      feeDisplay: r.fee?.display ?? null, canSign: r.can_sign === true, blocked: (r.blocked ?? []).map((b: any) => b.code),
      paymentReference: r.payment_reference, custody: r.custody,
    };
  },
  sendTransfer: (t: { to: string; amount: string; chainId: number; reference: string }) =>
    post<any>("/wallets/client/transfers", { to: t.to, amount: t.amount, chain_id: t.chainId, payment_reference: t.reference }),
  transferStatus: (reference: string) => get<any>(`/wallets/transfers/${encodeURIComponent(reference)}`),

  /** The provider's own paid-out balance (its WDK payee wallet) in test USDT. */
  /** Demo wallet of the person who pays this invoice (the milestone's client): name and balance. */
  payerWallet: async (invoiceId: string): Promise<{ name: string; balance: number | null }> => {
    const inv = await get<any>(`/invoices/${invoiceId}`);
    const role = await payerRole(inv.escrow_milestone_id);
    if (!role) return { name: "a connected wallet", balance: null };
    const name = WALLET_USERS.find((u) => u.role === role)?.name ?? role;
    let balance: number | null = null;
    try { balance = dollars((await get<any>(`/wallets/${role}/balance`)).usdt?.base_units); } catch { /* shown as unavailable */ }
    return { name, balance };
  },
  /** Demo wallet: balance in test USDT (dollars, 1:1) or null when the wallet's RPC read fails. */
  walletBalance: async (role: WalletUser): Promise<number | null> => {
    try { return dollars((await get<any>(`/wallets/${role}/balance`)).usdt?.base_units); } catch { return null; }
  },
  /** Demo wallet: recent activity (top-ups, milestone payments, payouts received). */
  walletActivity: async (role: WalletUser): Promise<WalletActivity[]> =>
    ((await get<any>(`/wallets/${role}/activity`)).items as any[]).map((i) => ({
      kind: i.kind, direction: i.direction, amount: dollars(i.amount), at: i.at, txHash: i.tx_hash ?? null, detail: i.detail, simulated: i.simulated === true,
    })),
  /**
   * Demo wallet: add funds by SIMULATED card. The treasury mints test USDT (1 USD = 1 tUSDT). The key is made once per
   * click, so a double submit is one top-up.
   */
  addFunds: (role: WalletUser, usd: number, key: string) =>
    post<{ amount_usd_cents: number; tx_hash: string; repeated: boolean }>(`/wallets/${role}/fund`, { amount_usd_cents: Math.round(usd * 100), idempotency_key: key }),
  providerBalance: async () => dollars((await get<any>("/wallets/payee_amara/balance")).usdt?.base_units),
  provider: () => provider(),
  countryProfiles: async () => (await get<{ profiles: any[] }>("/country-profiles")).profiles,
};

/**
 * The landing page's "try to overspend" demo: the same rule order as the Policy Service (INTERFACES v0.8), on
 * illustrative numbers in the browser. It decides nothing real; real plans are decided by the Policy Service.
 */
export function checkPolicy(amount: number, limit: number, opts: { injected?: boolean; payeeApproved?: boolean; milestoneAmount?: number } = {}) {
  const rejected: string[] = [];
  const escalated: string[] = [];
  if (amount === 0) rejected.push("ZERO_AMOUNT_PAYOUT");
  if (amount > 0) {
    if (opts.payeeApproved === false) rejected.push("PAYEE_NOT_ALLOWED");
    if (amount > limit) rejected.push("OVER_PER_TX_CAP");
    if (opts.milestoneAmount !== undefined && amount > opts.milestoneAmount) rejected.push("OVER_MILESTONE_AMOUNT");
  }
  if (opts.injected) escalated.push("INJECTION_FLAGGED");
  if (rejected.length > 0) return { decision: "REJECTED" as const, reasons: rejected };
  if (escalated.length > 0) return { decision: "ESCALATED" as const, reasons: escalated };
  return { decision: "APPROVED" as const, reasons: [] as string[] };
}

/** Every Policy Service reason code, for the Trust page and tests. */
export const POLICY_CODES = { rejected: POLICY_REJECT_CODES, escalated: POLICY_ESCALATE_CODES };

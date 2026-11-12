// DEMO MODE ONLY. One-click signing for the demo video: the operator, arbiter and provider TEST keys sign in the
// presenter's process (the seed), never in the backend or the Policy Service, and the web app labels every such
// action "Demo: signed with a test key". The real path stays the person's own browser wallet.
//
//   GET  /health                 roles and addresses
//   POST /sign                   { role, typed } -> { signer, signature, demo: true }   (only the typed data below)
//   POST /operator/limits        { per_tx_cap, per_tx_soft_limit?, daily_cap? } (base units) -> the Policy Service
//                                relays the operator-signed vault update on-chain; waits until the vault shows it
//   POST /platform/settle        { milestone_id } -> the platform's own step after the client approved: release the
//                                escrow to the vault, then settle (agent proposes, Policy Service decides, vault pays,
//                                receipt minted). Uses the platform token held by this process, never by the browser.
//
// Allowed typed data, by role (anything else is refused):
//   operator  TethranOperator.IdentityDecision, TethranPolicy.ApprovalDecision
//   arbiter   TethranEscrow.Attestation (on the configured escrow)
//   provider  TethranContract.ContractSignature
import { createServer, request, type Server } from "node:http";
import { Wallet } from "ethers";
import { VAULT_TYPES, type EvmChainClient } from "../../chain/src/index";
import { policyDocumentTypes, policyDocumentValue, policyDomain } from "../../policy/src/typed";

type Typed = { domain: Record<string, any>; types: Record<string, { name: string; type: string }[]>; primaryType?: string; message: Record<string, any> };

const ALLOWED: Record<string, { domain: string; type: string }[]> = {
  operator: [{ domain: "TethranOperator", type: "IdentityDecision" }, { domain: "TethranPolicy", type: "ApprovalDecision" }],
  arbiter: [{ domain: "TethranEscrow", type: "Attestation" }],
  provider: [{ domain: "TethranContract", type: "ContractSignature" }],
};

export function startDemoSigner(opts: {
  port: number;
  origins: string[];
  keys: { operator: Wallet; arbiter: Wallet; provider: Wallet };
  relay: EvmChainClient;
  vault: string;
  escrow: string;
  policyUrl: string;
  /** The backend and the platform token for /platform/settle. */
  platform: { backendUrl: string; token: string };
  log: (line: string) => void;
}): Server {
  const send = (res: any, origin: string, status: number, body: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.origins.includes(origin)) Object.assign(headers, { "access-control-allow-origin": origin, vary: "Origin" });
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  async function sign(role: string, typed: Typed) {
    const wallet = opts.keys[role as keyof typeof opts.keys];
    if (!wallet) throw Object.assign(new Error("role must be operator, arbiter or provider"), { status: 400 });
    const types = Object.fromEntries(Object.entries(typed.types ?? {}).filter(([k]) => k !== "EIP712Domain"));
    const primary = typed.primaryType ?? Object.keys(types)[0];
    const ok = ALLOWED[role]!.some((a) => a.domain === typed.domain?.name && a.type === primary && Object.keys(types).length === 1);
    if (!ok) throw Object.assign(new Error(`the ${role} demo key does not sign ${typed.domain?.name}.${primary}`), { status: 403 });
    if (primary === "Attestation" && String(typed.domain.verifyingContract).toLowerCase() !== opts.escrow.toLowerCase()) {
      throw Object.assign(new Error("attestations are signed only for the configured escrow"), { status: 403 });
    }
    const signature = await wallet.signTypedData(typed.domain, types, typed.message);
    opts.log(`demo signer: ${role} signed ${typed.domain.name}.${primary}`);
    return { signer: wallet.address, signature, demo: true, label: "Demo: signed with a test key" };
  }

  async function setLimits(body: any) {
    const amount = (v: unknown, name: string) => {
      if (typeof v !== "string" || !/^[0-9]+$/.test(v)) throw Object.assign(new Error(`${name} must be base units`), { status: 400 });
      return v;
    };
    const current = await (await fetch(`${opts.policyUrl}/v1/policy`)).json() as { policy: Record<string, any>; version: number };
    const perTx = amount(body?.per_tx_cap, "per_tx_cap");
    const soft = body?.per_tx_soft_limit !== undefined ? amount(body.per_tx_soft_limit, "per_tx_soft_limit") : (BigInt(perTx) < BigInt(current.policy.per_tx_soft_limit) ? perTx : current.policy.per_tx_soft_limit);
    const doc: Record<string, any> = {
      ...current.policy, version: current.version + 1, per_tx_cap: perTx,
      per_tx_soft_limit: BigInt(soft) > BigInt(perTx) ? perTx : soft,
      daily_cap: body?.daily_cap !== undefined ? amount(body.daily_cap, "daily_cap") : current.policy.daily_cap,
    };
    // The operator signs the off-chain policy and, in the vault's own format, the on-chain limits. The Policy Service
    // checks both signatures and relays the vault update; the vault enforces it at once.
    const onChain = await opts.relay.vaultState(opts.vault);
    const actions: Record<string, unknown>[] = [];
    if (onChain.perTxCap !== doc.per_tx_cap || onChain.dailyCap !== doc.daily_cap || onChain.minReserve !== doc.vault_min_reserve) {
      const a = { version: onChain.policyVersion + 1, perTxCap: doc.per_tx_cap, dailyCap: doc.daily_cap, minReserve: doc.vault_min_reserve };
      actions.push({ type: "setPolicy", ...a, operator_signature: await opts.keys.operator.signTypedData(opts.relay.vaultDomain(opts.vault), { SetPolicy: [...VAULT_TYPES.SetPolicy] }, a) });
    }
    const operator_signature = await opts.keys.operator.signTypedData(policyDomain as never, policyDocumentTypes as never, policyDocumentValue(doc.version, doc as never) as never);
    const res = await fetch(`${opts.policyUrl}/v1/policy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: doc, version: doc.version, operator_signature, vault: opts.vault, vault_actions: actions }),
    });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out?.error?.message ?? out?.error ?? `Policy Service answered ${res.status}`), { status: 502 });
    // Wait until this process's RPC sees the change (a public node can lag a block or two).
    for (let i = 0; i < 40 && (await opts.relay.vaultState(opts.vault)).perTxCap !== doc.per_tx_cap; i++) await new Promise((r) => setTimeout(r, 3000));
    const after = await opts.relay.vaultState(opts.vault);
    opts.log(`demo signer: operator set per-tx cap ${doc.per_tx_cap} (policy v${doc.version}, vault v${after.policyVersion})`);
    return {
      policy_version: doc.version, vault_policy_version: after.policyVersion, per_tx_cap: after.perTxCap,
      vault_transactions: out.vault_transactions ?? [], demo: true, label: "Demo: signed with a test key",
    };
  }

  async function platformSettle(body: any) {
    const id = body?.milestone_id;
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw Object.assign(new Error("milestone_id is required"), { status: 400 });
    // node:http rather than fetch: a settlement on a public test network can take longer than fetch's 5-minute
    // header timeout (several transactions, each waiting for confirmations).
    const call = (step: "release" | "settle") => new Promise<any>((resolve, reject) => {
      const req = request(`${opts.platform.backendUrl}/milestones/${id}/${step}`, {
        method: "POST", headers: { "content-type": "application/json", "x-platform-token": opts.platform.token },
      }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let out: any = {};
          try { out = JSON.parse(text); } catch { /* not JSON */ }
          const status = res.statusCode ?? 500;
          if (status >= 400) return reject(Object.assign(new Error(out?.error?.message ?? out?.error ?? `${step} answered ${status}`), { status: status === 409 ? 409 : 502 }));
          resolve(out);
        });
      });
      req.on("error", (e) => reject(Object.assign(e, { status: 502 })));
      req.end("{}");
    });
    const release = await call("release"); // idempotent: an already released milestone answers { already: true }
    const settle = await call("settle");
    opts.log(`demo signer: platform released and settled ${id.slice(0, 8)} -> ${settle?.decision}`);
    return { release, settle, demo: true, label: "Demo: platform step run by the presenter's process" };
  }

  const server = createServer(async (req, res) => {
    const origin = String(req.headers.origin ?? "");
    if (req.method === "OPTIONS") {
      if (!opts.origins.includes(origin)) { res.writeHead(403); return res.end(); }
      res.writeHead(204, {
        "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type", "access-control-max-age": "600",
      });
      return res.end();
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, origin, 200, {
          demo: true, label: "Demo: signed with a test key",
          roles: { operator: opts.keys.operator.address, arbiter: opts.keys.arbiter.address, provider: opts.keys.provider.address },
        });
      }
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) throw Object.assign(new Error("body too large"), { status: 413 }); }
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "POST" && url.pathname === "/sign") return send(res, origin, 200, await sign(String(body.role), body.typed));
      if (req.method === "POST" && url.pathname === "/operator/limits") return send(res, origin, 200, await setLimits(body));
      if (req.method === "POST" && url.pathname === "/platform/settle") return send(res, origin, 200, await platformSettle(body));
      return send(res, origin, 404, { error: "not found" });
    } catch (e: any) {
      return send(res, origin, e?.status ?? 500, { error: String(e?.message ?? "error").replace(/https?:\/\/\S+/g, "[url]") });
    }
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}

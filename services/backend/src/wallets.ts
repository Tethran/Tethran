// Wallet layer for the review screen (PRD M12), on WDK wallets (services/chain/src/wdk.ts).
//
//   review    recipient (with saved-recipient name), network, amount and fee shown separately, and every reason the
//             send would be blocked, before anything is signed
//   send      blocks a second send while the same payment reference is pending or done; detects a wrong network
//             before signing; signs and sends with WDK; stores the tx hash as the payment reference's record
//   status    rechecks the SAME tx hash on the chain (for a reconnect); never resubmits
//
// DEMO CUSTODY: in the product these wallets are self-custodial on the user's device (WDK in the app). In this
// API-only build a demo wallet service holds the test seed. Labelled in every response.
import type { DatabaseSync } from "node:sqlite";
import { formatEther, getAddress, isAddress } from "ethers";
import { PolicyViolationError, WALLET_ROLES, type WalletRole, type WdkWallets } from "../../chain/src/index";
import type { TxStatus } from "../../chain/src/index";
import { ApiError } from "./errors";

const CUSTODY = "demo custody: test seed held by the demo wallet service (self-custodial on the user's device in the product)";

export function migrateWallets(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_transfers (
      payment_reference TEXT PRIMARY KEY, role TEXT NOT NULL, to_address TEXT NOT NULL, amount TEXT NOT NULL,
      chain_id INTEGER NOT NULL, tx_hash TEXT, status TEXT NOT NULL, fee_wei TEXT, error TEXT, created_at TEXT NOT NULL, checked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS saved_recipients (
      role TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY (role, address)
    );
  `);
}

export interface WalletLayerDeps {
  db: DatabaseSync;
  wallets: WdkWallets;
  chain: { chainId: number; name: string; usdt: string; ready(): Promise<void>; txStatus(h: string): Promise<TxStatus> };
  now: () => Date;
  /** Escrow calls signed by a role's WDK wallet (approve, dispute). */
  escrowFor?: (role: WalletRole) => { approve(id: string, key: string): Promise<{ txHash: string }>; dispute(id: string, key: string): Promise<{ txHash: string }>; waitConfirmed(h: string): Promise<void> };
  attestationTypedData?: (milestoneId: string, kind: 0 | 1 | 2, release: boolean) => { domain: any; types: any; message: any };
}

const usdtString = (base: bigint) => {
  const whole = base / 1_000_000n;
  const frac = (base % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};

export function createWalletLayer(deps: WalletLayerDeps) {
  const { db, wallets, chain } = deps;
  migrateWallets(db);
  const role = (r: unknown): WalletRole => {
    if (typeof r !== "string" || !(r in WALLET_ROLES)) throw new ApiError(404, `unknown wallet "${String(r)}"`);
    return r as WalletRole;
  };
  const prior = (ref: string) => db.prepare("SELECT * FROM wallet_transfers WHERE payment_reference = ?").get(ref) as any;

  /** Every reason a send would be blocked right now. Empty means it may be signed. */
  async function checks(r: WalletRole, req: { to: unknown; amount: unknown; chain_id: unknown; payment_reference: unknown }) {
    const blocks: { code: string; detail: string }[] = [];
    if (typeof req.to !== "string" || !isAddress(req.to)) blocks.push({ code: "BAD_ADDRESS", detail: "recipient is not a valid address" });
    if (typeof req.amount !== "string" || !/^[0-9]+$/.test(req.amount) || BigInt(req.amount) === 0n) blocks.push({ code: "BAD_AMOUNT", detail: "amount must be a positive integer string in base units" });
    if (typeof req.payment_reference !== "string" || req.payment_reference.length < 3) blocks.push({ code: "NO_REFERENCE", detail: "a payment_reference is required (it blocks duplicate sends)" });
    // Wrong network: the app says which chain it thinks it is on; it must be the wallet's chain, and the RPC
    // endpoint must really be that chain (ChainClient.ready checks eth_chainId against the config).
    if (Number(req.chain_id) !== wallets.chainId) {
      blocks.push({ code: "WRONG_NETWORK", detail: `the app is on chain ${req.chain_id}; this wallet and the escrow are on ${chain.name} (${wallets.chainId}). Switch network before signing.` });
    } else {
      try { await chain.ready(); } catch { blocks.push({ code: "WRONG_NETWORK", detail: "the connected RPC endpoint is not the expected chain" }); }
    }
    if (typeof req.payment_reference === "string") {
      const p = prior(req.payment_reference);
      if (p && (p.status === "pending" || p.status === "unknown")) blocks.push({ code: "DUPLICATE_PENDING", detail: `a send with this payment reference is still pending (${p.tx_hash ?? "no hash yet"})` });
      if (p && p.status === "confirmed") blocks.push({ code: "ALREADY_SENT", detail: `this payment reference was already paid (${p.tx_hash})` });
    }
    return blocks;
  }

  return {
    custody: CUSTODY,

    async list() {
      const out = [];
      for (const r of Object.keys(WALLET_ROLES) as WalletRole[]) out.push({ role: r, address: await wallets.address(r), chain_id: wallets.chainId });
      return { wallets: out, provider: "Tether WDK (@tetherto/wdk, @tetherto/wdk-wallet-evm)", custody: CUSTODY };
    },

    async balance(r: unknown) {
      const a = await wallets.account(role(r));
      const [usdt, native] = await Promise.all([a.getTokenBalance(chain.usdt), a.getBalance()]);
      return {
        role: r, address: await a.getAddress(), chain_id: wallets.chainId, network: chain.name,
        usdt: { base_units: usdt.toString(), display: `${usdtString(usdt)} tUSDT (test token)` },
        gas: { wei: native.toString(), display: `${formatEther(native)} ETH (test)` },
      };
    },

    saveRecipient(r: unknown, body: { name?: unknown; address?: unknown }) {
      const w = role(r);
      if (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 80) throw new ApiError(400, "name is required (max 80 chars)");
      if (typeof body.address !== "string" || !isAddress(body.address)) throw new ApiError(400, "address must be an address");
      db.prepare("INSERT OR REPLACE INTO saved_recipients VALUES (?, ?, ?)").run(w, body.name, getAddress(body.address));
      return { role: w, name: body.name, address: getAddress(body.address) };
    },

    recipients(r: unknown) {
      return db.prepare("SELECT name, address FROM saved_recipients WHERE role = ? ORDER BY name").all(role(r));
    },

    /** What the review screen shows before the user signs. Nothing is signed here. */
    async review(r: unknown, body: Record<string, unknown>) {
      const w = role(r);
      const blocks = await checks(w, body as never);
      let fee: bigint | null = null;
      if (!blocks.some((b) => b.code === "BAD_ADDRESS" || b.code === "BAD_AMOUNT")) {
        try {
          // A fee estimate is read-only, so it is asked again if a lagging RPC node has not seen a new balance yet.
          const quote = () => wallets.account(w).then((acc) => acc.quoteTransfer({ token: chain.usdt, recipient: getAddress(body.to as string), amount: BigInt(body.amount as string) }));
          for (let attempt = 1; ; attempt++) {
            try { fee = (await quote()).fee; break; } catch (e) {
              if (e instanceof PolicyViolationError || attempt >= 3) throw e;
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
        } catch (e) {
          blocks.push(e instanceof PolicyViolationError
            ? { code: "WALLET_POLICY", detail: "the wallet's WDK policy does not allow this transfer" }
            : { code: "FEE_UNAVAILABLE", detail: "could not estimate the network fee" });
        }
      }
      const saved = typeof body.to === "string" && isAddress(body.to)
        ? db.prepare("SELECT name FROM saved_recipients WHERE role = ? AND address = ?").get(w, getAddress(body.to)) as { name: string } | undefined
        : undefined;
      const amount = typeof body.amount === "string" && /^[0-9]+$/.test(body.amount) ? BigInt(body.amount) : 0n;
      return {
        from: await wallets.address(w),
        recipient: { address: typeof body.to === "string" ? body.to : null, saved_name: saved?.name ?? null, saved: Boolean(saved) },
        network: { name: chain.name, chain_id: wallets.chainId },
        amount: { base_units: amount.toString(), display: `${usdtString(amount)} tUSDT (test token)` },
        // The network fee is paid in test ETH and is shown apart from the amount; it is not taken from the amount.
        fee: fee === null ? null : { wei: fee.toString(), display: `${formatEther(fee)} ETH (test), estimated`, paid_in: "ETH" },
        payment_reference: body.payment_reference ?? null,
        can_sign: blocks.length === 0,
        blocked: blocks,
        custody: CUSTODY,
      };
    },

    /** Signs and sends after the same checks as the review. A blocked send is refused before signing. */
    async send(r: unknown, body: Record<string, unknown>) {
      const w = role(r);
      const blocks = await checks(w, body as never);
      if (blocks.length > 0) {
        const first = blocks[0];
        throw new ApiError(first.code === "BAD_ADDRESS" || first.code === "BAD_AMOUNT" || first.code === "NO_REFERENCE" ? 400 : 409, first.detail, first.code);
      }
      const ref = body.payment_reference as string;
      const to = getAddress(body.to as string);
      // A transfer that failed on-chain sent nothing: the same reference may be used again.
      if (prior(ref)?.status === "failed") db.prepare("DELETE FROM wallet_transfers WHERE payment_reference = ?").run(ref);
      // Claim the reference before signing, so two requests at once cannot both send.
      const claimed = db.prepare("INSERT OR IGNORE INTO wallet_transfers (payment_reference, role, to_address, amount, chain_id, tx_hash, status, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'unknown', ?)")
        .run(ref, w, to, body.amount as string, wallets.chainId, deps.now().toISOString());
      if (claimed.changes !== 1) throw new ApiError(409, "a send with this payment reference is already in progress", "DUPLICATE_PENDING");
      try {
        const res = await (await wallets.account(w)).transfer({ token: chain.usdt, recipient: to, amount: BigInt(body.amount as string) });
        db.prepare("UPDATE wallet_transfers SET tx_hash = ?, status = 'pending', fee_wei = ? WHERE payment_reference = ?").run(res.hash, res.fee.toString(), ref);
        return { payment_reference: ref, tx_hash: res.hash, status: "pending", fee: { wei: res.fee.toString(), display: `${formatEther(res.fee)} ETH (test)` }, custody: CUSTODY };
      } catch (e) {
        if (e instanceof PolicyViolationError) {
          // Refused by WDK before signing: nothing was sent, so the reference can be used again.
          db.prepare("DELETE FROM wallet_transfers WHERE payment_reference = ?").run(ref);
          throw new ApiError(409, "the wallet's WDK policy refused this transfer", "WALLET_POLICY");
        }
        // Unknown outcome: the reference stays blocked until a status check finds the transaction or an operator clears it.
        db.prepare("UPDATE wallet_transfers SET error = ? WHERE payment_reference = ?").run(String((e as Error)?.message ?? e).slice(0, 200), ref);
        throw new ApiError(502, "send failed or its outcome is unknown; the payment reference stays blocked", "SEND_UNKNOWN");
      }
    },

    /** The role's own escrow action (the client approves; client or provider disputes), signed by its WDK wallet. */
    async escrowAction(r: unknown, milestoneId: string, action: string) {
      const w = role(r);
      if (!deps.escrowFor) throw new ApiError(404, "escrow actions are not configured");
      if (action !== "approve" && action !== "dispute") throw new ApiError(404, "unknown escrow action");
      const c = deps.escrowFor(w);
      const tx = await c[action](milestoneId, `wallet:${w}:${action}:${milestoneId}`);
      await c.waitConfirmed(tx.txHash);
      return { role: w, milestone_id: milestoneId, action, tx_hash: tx.txHash, signed_by: "Tether WDK wallet", custody: CUSTODY };
    },

    /** Signs a dispute attestation with the role's WDK wallet (EIP-712); the arbiter endpoint collects it. */
    async signAttestation(r: unknown, milestoneId: string, body: { kind?: unknown; release_to_provider?: unknown }) {
      const w = role(r);
      if (!deps.attestationTypedData) throw new ApiError(404, "attestations are not configured");
      const kinds: Record<string, 0 | 1 | 2> = { client: 0, provider: 1, arbiter: 2 };
      if (typeof body.kind !== "string" || !(body.kind in kinds)) throw new ApiError(400, "kind must be client, provider or arbiter");
      if (typeof body.release_to_provider !== "boolean") throw new ApiError(400, "release_to_provider must be a boolean");
      const td = deps.attestationTypedData(milestoneId, kinds[body.kind], body.release_to_provider);
      const signature = await (await wallets.account(w)).signTypedData({ domain: td.domain, types: td.types, message: td.message });
      return { signer: await wallets.address(w), signature, release_to_provider: body.release_to_provider, custody: CUSTODY };
    },

    /** Reconnect: recheck the same transaction hash. Never resubmits. */
    async status(ref: string) {
      const p = prior(ref);
      if (!p) throw new ApiError(404, "no send with this payment reference");
      if (!p.tx_hash) return { payment_reference: ref, status: "unknown", tx_hash: null, note: "the send was interrupted before a hash was recorded; it is not resent", rechecked: false };
      if (p.status === "confirmed" || p.status === "failed") return { payment_reference: ref, status: p.status, tx_hash: p.tx_hash, rechecked: false };
      const s = await chain.txStatus(p.tx_hash);
      const status = s === "confirmed" ? "confirmed" : s === "failed" ? "failed" : "pending";
      db.prepare("UPDATE wallet_transfers SET status = ?, checked_at = ? WHERE payment_reference = ?").run(status, deps.now().toISOString(), ref);
      return { payment_reference: ref, status, tx_hash: p.tx_hash, rechecked: true, last_known: p.status };
    },
  };
}

export type WalletLayer = ReturnType<typeof createWalletLayer>;

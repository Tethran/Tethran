// Consented phone-to-wallet registry (PRD FR-8.3). SIMULATED: there is no real mobile-network lookup and no
// one-time-code ownership check; a real deployment would verify the phone by SMS before registering it.
//
// Privacy: only a keyed hash (HMAC-SHA256 with a per-deployment salt) of the E.164 number is stored. A plain number
// is never stored, logged or returned; responses carry a masked form (+234•••••4567). The wallet is only used when
// the owner has given consent, and withdrawing consent clears the stored wallet.
import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAddress, getAddress } from "ethers";
import { ApiError, bad } from "./errors";
import { RAILS, createAdapters, validAmount, type PayoutAdapter, type Rail } from "./payouts";

/** DEMO DEFAULT ONLY. Set PHONE_HASH_SALT per deployment; with this default, hashes are guessable across deployments. */
export const DEMO_PHONE_HASH_SALT = "tethran-demo-salt-do-not-use-in-production";

export function migratePhoneRegistry(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_registry (
      phone_hash TEXT PRIMARY KEY, wallet_address TEXT, rail TEXT NOT NULL, account_ref TEXT,
      consent_at TEXT NOT NULL, consent_withdrawn_at TEXT, created_at TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 1
    );
  `);
}

/** Normalises to E.164 ("+" and 8 to 15 digits). "00" prefixes are accepted; no default country is guessed. */
export function normalisePhone(input: unknown): string {
  if (typeof input !== "string") return bad("phone is required");
  let s = input.trim().replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return bad("phone must be in international format, for example +2348012344567");
  return s;
}

export function hashPhone(e164: string, salt: string): string {
  return createHmac("sha256", salt).update(e164).digest("hex");
}

export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)}•••••${e164.slice(-4)}`;
}

const COUNTRY_CODES: [string, string][] = [["+254", "KE"], ["+233", "GH"], ["+256", "UG"], ["+234", "NG"], ["+255", "TZ"], ["+27", "ZA"]];
export function countryOfPhone(e164: string): string | undefined {
  return COUNTRY_CODES.find(([p]) => e164.startsWith(p))?.[1];
}

interface Entry {
  phone_hash: string; wallet_address: string | null; rail: string; account_ref: string | null; consent_at: string;
  consent_withdrawn_at: string | null;
}

type Ctx = { params: Record<string, string>; body: any; url: URL };
type Handler = (ctx: Ctx) => Promise<unknown>;

export interface PhoneRegistryDeps {
  db: DatabaseSync;
  now: () => Date;
  /** PHONE_HASH_SALT from config; falls back to the labelled demo default. */
  salt?: string;
  adapters?: Record<Rail, PayoutAdapter>;
}

export function createPhoneRegistry(deps: PhoneRegistryDeps) {
  const { db, now } = deps;
  const salt = deps.salt || DEMO_PHONE_HASH_SALT;
  const adapters = deps.adapters ?? createAdapters(now);
  const entry = (hash: string) => db.prepare("SELECT * FROM phone_registry WHERE phone_hash = ?").get(hash) as Entry | undefined;
  const active = (e?: Entry): e is Entry => !!e && !e.consent_withdrawn_at && !!e.wallet_address;

  return {
    register(body: any) {
      if (body?.consent !== true) throw new ApiError(400, "explicit consent is required: send consent: true", "CONSENT_REQUIRED");
      const phone = normalisePhone(body?.phone);
      const rail = body?.rail as Rail;
      if (!RAILS.includes(rail)) return bad(`rail must be one of ${RAILS.join(", ")}`);
      if (typeof body?.wallet_address !== "string" || !isAddress(body.wallet_address)) return bad("wallet_address must be an EVM address");
      const wallet = getAddress(body.wallet_address);
      const accountRef = typeof body?.account_ref === "string" && body.account_ref.length <= 64 ? body.account_ref : null;
      const hash = hashPhone(phone, salt);
      const prior = entry(hash);
      if (active(prior) && prior.wallet_address !== wallet) {
        throw new ApiError(409, "this number is already registered to another wallet; the owner must withdraw consent first", "ALREADY_REGISTERED");
      }
      const t = now().toISOString();
      if (!prior) {
        db.prepare("INSERT INTO phone_registry (phone_hash, wallet_address, rail, account_ref, consent_at, consent_withdrawn_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)")
          .run(hash, wallet, rail, accountRef, t, t);
      } else if (!active(prior)) {
        db.prepare("UPDATE phone_registry SET wallet_address = ?, rail = ?, account_ref = ?, consent_at = ?, consent_withdrawn_at = NULL WHERE phone_hash = ?")
          .run(wallet, rail, accountRef, t, hash);
      } else {
        db.prepare("UPDATE phone_registry SET rail = ?, account_ref = ? WHERE phone_hash = ?").run(rail, accountRef, hash);
      }
      const e = entry(hash)!;
      return { simulated: true, phone_hash: hash, phone_masked: maskPhone(phone), rail: e.rail, consented: true, consent_at: e.consent_at };
    },

    withdraw(phoneHash: string) {
      if (!/^[0-9a-f]{64}$/.test(phoneHash)) throw new ApiError(400, "phone hash must be 64 hex characters");
      const e = entry(phoneHash);
      if (!e) throw new ApiError(404, "no registration for this phone hash");
      if (!e.consent_withdrawn_at) {
        // Data minimisation: the wallet and account reference are erased, only the hash and timestamps stay for audit.
        db.prepare("UPDATE phone_registry SET consent_withdrawn_at = ?, wallet_address = NULL, account_ref = NULL WHERE phone_hash = ?")
          .run(now().toISOString(), phoneHash);
      }
      return { simulated: true, phone_hash: phoneHash, consented: false, consent_withdrawn_at: entry(phoneHash)!.consent_withdrawn_at };
    },

    /** Masked result only: never returns the wallet address. */
    resolve(body: any) {
      const phone = normalisePhone(body?.phone);
      const e = entry(hashPhone(phone, salt));
      const base = { simulated: true as const, phone_masked: maskPhone(phone), country: countryOfPhone(phone) ?? null };
      if (!active(e)) return { ...base, registered: false, consented: false, rail: null };
      return { ...base, registered: true, consented: true, rail: e.rail, phone_hash: e.phone_hash };
    },

    /** Resolves the phone to a payee object. Does NOT move money; the main session turns the payee into a payout. */
    async sendToPhone(body: any) {
      const phone = normalisePhone(body?.phone);
      const amount = validAmount(body?.amount);
      const hash = hashPhone(phone, salt);
      const e = entry(hash);
      if (!active(e)) throw new ApiError(404, "this phone number is not registered, or the owner withdrew consent", "NOT_REGISTERED");
      const rail = e.rail as Rail;
      const country = countryOfPhone(phone);
      // The phone's country is used when the rail serves it; otherwise the rail's default country is quoted.
      const quote = await adapters[rail].quote({ rail, amount, country: rail === "usdt" ? undefined : country })
        .catch(() => adapters[rail].quote({ rail, amount }));
      return {
        simulated: true,
        note: "Resolved only. No money was sent; create a payout for this payee through the settlement flow. Phone lookup is simulated.",
        phone_masked: maskPhone(phone),
        payee: {
          payee_id: `phone_${hash.slice(0, 12)}`, name: `Phone ${maskPhone(phone)}`, address: e.wallet_address,
          rail, simulated: rail !== "usdt", verified_name: null, phone_hash: hash,
        },
        amount, quote,
      };
    },
  };
}

export function phoneRegistryRoutes(deps: PhoneRegistryDeps): [string, RegExp, Handler][] {
  const reg = createPhoneRegistry(deps);
  return [
    ["POST", /^\/phone-registry$/, async ({ body }) => reg.register(body)],
    ["POST", /^\/phone-registry\/resolve$/, async ({ body }) => reg.resolve(body)],
    ["DELETE", /^\/phone-registry\/([^/]+)$/, async ({ params }) => reg.withdraw(params[1])],
    ["POST", /^\/send-to-phone$/, async ({ body }) => reg.sendToPhone(body)],
  ];
}

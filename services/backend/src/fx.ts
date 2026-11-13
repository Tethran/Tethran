// Indicative exchange rates for the app (v0.12): real rates from ExchangeRate-API's open endpoint, for showing what a
// simulated mobile-money or bank payout would be in local currency. No key, no dependency (fetch).
//
//   https://open.er-api.com/v6/latest/USD   (updates once a day; we cache 6 hours, so a few calls a day at most)
//
// Attribution (required by the provider): "Rates By Exchange Rate API" linking to https://www.exchangerate-api.com.
// Labels: "Indicative rate, last updated <date>" (never "Live"). The conversion and the payout leg stay "Simulated".
// The rate is locked to a milestone when the milestone is created, so a rate change never alters amounts already shown.
// Fallback when the API is down or slow: the last cached response, else the previous sample table (labelled so).
//
// LICENCE LIMIT: ExchangeRate-API's terms allow these rates only for our own end use ("not in any product or service
// that offers programmatic or automatic access to exchange rate data"; no re-distribution). So this service feeds the
// app's own screens and payout quotes ONLY. It must never back a paid or programmatic endpoint: /x402/fx-quote keeps
// its own "Sample rates" table (x402.ts) on purpose.
import type { DatabaseSync } from "node:sqlite";

export const FX_URL = "https://open.er-api.com/v6/latest/USD";
export const FX_CACHE_MS = 6 * 60 * 60 * 1000;
export const FX_TIMEOUT_MS = 4_000;
export const FX_ATTRIBUTION = { text: "Rates By Exchange Rate API", url: "https://www.exchangerate-api.com" } as const;
/** The currencies of our corridors. */
export const FX_CURRENCIES = ["NGN", "GHS", "KES", "ZAR", "UGX", "TZS"] as const;
/** The previous sample table (1 USD in local currency, 6 decimals): used only when no real rate was ever fetched. */
export const SAMPLE_RATES_MICRO: Record<string, bigint> = {
  KES: 129_000_000n, GHS: 15_500_000n, UGX: 3_700_000_000n, NGN: 1_500_000_000n, TZS: 2_600_000_000n, ZAR: 18_000_000n,
};

export type FxSource = "exchangerate-api" | "exchangerate-api (cached)" | "sample";
export interface FxRate {
  currency: string;
  /** 1 USD (= 1 test USDT here) in local currency, 6 decimals. */
  rateMicro: bigint;
  source: FxSource;
  /** The provider's own "last updated" time (UTC), or null for the sample table. */
  lastUpdated: string | null;
  label: string;
  attribution: typeof FX_ATTRIBUTION | null;
  /** True when this rate was locked to a milestone at creation. */
  locked: boolean;
}

const toMicro = (n: number) => BigInt(Math.round(n * 1_000_000));
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function fxLabel(source: FxSource, lastUpdated: string | null): string {
  if (source === "sample" || !lastUpdated) return "Sample rate (indicative rates unavailable)";
  return `Indicative rate, last updated ${day(lastUpdated)}`;
}

export function createFxService(opts: { db: DatabaseSync; now: () => Date; fetch?: typeof fetch; url?: string; ttlMs?: number; timeoutMs?: number }) {
  const { db } = opts;
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.ttlMs ?? FX_CACHE_MS;
  db.exec(`
    CREATE TABLE IF NOT EXISTS fx_cache (id INTEGER PRIMARY KEY CHECK (id = 1), rates_json TEXT NOT NULL, last_update_utc TEXT NOT NULL, fetched_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS milestone_fx_locks (milestone_id TEXT PRIMARY KEY, rates_json TEXT NOT NULL, source TEXT NOT NULL, last_update_utc TEXT, locked_at TEXT NOT NULL);
  `);
  let inFlight: Promise<void> | null = null;
  let lastError: string | null = null;

  const cached = () => db.prepare("SELECT * FROM fx_cache WHERE id = 1").get() as { rates_json: string; last_update_utc: string; fetched_at: string } | undefined;
  const fresh = () => { const c = cached(); return !!c && opts.now().getTime() - Date.parse(c.fetched_at) < ttl; };

  /** Fetches the rates when the cache is older than 6 hours. Never throws: a failure keeps the last good rates. */
  async function refresh(force = false): Promise<void> {
    if (!force && fresh()) return;
    inFlight ??= (async () => {
      try {
        // The abort signal ends the request; the race also bounds a fetch that ignores the signal.
        const ms = opts.timeoutMs ?? FX_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms); });
        const res = await Promise.race([doFetch(opts.url ?? FX_URL, { signal: AbortSignal.timeout(ms) }), timeout]).finally(() => clearTimeout(timer));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
        if (j.result !== "success" || !j.rates) throw new Error("unexpected response");
        const rates: Record<string, number> = {};
        for (const c of FX_CURRENCIES) if (typeof j.rates[c] === "number" && j.rates[c] > 0) rates[c] = j.rates[c];
        if (Object.keys(rates).length === 0) throw new Error("none of our currencies in the response");
        const last = j.time_last_update_utc ? new Date(j.time_last_update_utc).toISOString() : opts.now().toISOString();
        db.prepare("INSERT OR REPLACE INTO fx_cache (id, rates_json, last_update_utc, fetched_at) VALUES (1, ?, ?, ?)").run(JSON.stringify(rates), last, opts.now().toISOString());
        lastError = null;
      } catch (e) {
        lastError = (e as Error)?.name === "TimeoutError" ? "timeout" : String((e as Error)?.message ?? e).slice(0, 120);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** The current rate for a currency: the cache (fresh or stale), else the sample table. Synchronous. */
  function current(currency: string): FxRate {
    const c = cached();
    const r = c ? (JSON.parse(c.rates_json) as Record<string, number>)[currency] : undefined;
    if (c && r) {
      const source: FxSource = fresh() && !lastError ? "exchangerate-api" : "exchangerate-api (cached)";
      return { currency, rateMicro: toMicro(r), source, lastUpdated: c.last_update_utc, label: fxLabel(source, c.last_update_utc), attribution: FX_ATTRIBUTION, locked: false };
    }
    const s = SAMPLE_RATES_MICRO[currency];
    if (!s) throw new Error(`no rate for ${currency}`);
    return { currency, rateMicro: s, source: "sample", lastUpdated: null, label: fxLabel("sample", null), attribution: null, locked: false };
  }

  return {
    refresh,
    current,
    lastError: () => lastError,
    /** Locks today's rates to a milestone (once; later calls keep the first lock). */
    lock(milestoneId: string) {
      const rates: Record<string, string> = {};
      let source: FxSource = "sample";
      let last: string | null = null;
      for (const c of FX_CURRENCIES) {
        const r = current(c);
        rates[c] = r.rateMicro.toString();
        source = r.source;
        last = r.lastUpdated;
      }
      db.prepare("INSERT OR IGNORE INTO milestone_fx_locks (milestone_id, rates_json, source, last_update_utc, locked_at) VALUES (?, ?, ?, ?, ?)")
        .run(milestoneId, JSON.stringify(rates), source, last, opts.now().toISOString());
    },
    /** The milestone's locked rate when it has one, else the current rate. */
    rateFor(currency: string, milestoneId?: string | null): FxRate {
      if (milestoneId) {
        const l = db.prepare("SELECT * FROM milestone_fx_locks WHERE milestone_id = ?").get(milestoneId) as { rates_json: string; source: FxSource; last_update_utc: string | null } | undefined;
        const micro = l ? (JSON.parse(l.rates_json) as Record<string, string>)[currency] : undefined;
        if (l && micro) {
          const source = l.source === "exchangerate-api (cached)" ? "exchangerate-api" : l.source;
          return { currency, rateMicro: BigInt(micro), source, lastUpdated: l.last_update_utc, label: fxLabel(source, l.last_update_utc), attribution: source === "sample" ? null : FX_ATTRIBUTION, locked: true };
        }
      }
      return current(currency);
    },
  };
}
export type FxService = ReturnType<typeof createFxService>;

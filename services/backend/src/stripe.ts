// Stripe webhook signature verification, following Stripe's documented scheme:
//   header Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=...]
//   signed payload = `${t}.${rawBody}`, HMAC-SHA256 with the endpoint's webhook secret (whsec_...)
// The raw request body must be used exactly as received. Events older than the tolerance are refused,
// which limits replay. Event ids are also recorded so a replayed event is handled once (see treasury.ts).
import { createHmac, timingSafeEqual } from "node:crypto";

export class StripeSignatureError extends Error {}

export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): void {
  if (!secret) throw new StripeSignatureError("webhook secret not configured");
  if (!header) throw new StripeSignatureError("missing Stripe-Signature header");
  let t: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k === "t") t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  if (t === undefined || !Number.isInteger(t) || v1.length === 0) throw new StripeSignatureError("malformed Stripe-Signature header");
  if (Math.abs(nowSeconds - t) > toleranceSeconds) throw new StripeSignatureError("timestamp outside the tolerance");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  const ok = v1.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new StripeSignatureError("signature does not match");
}

/** Builds a valid header for a body. Used by tests and by the local demo (no Stripe account needed). */
export function signStripePayload(rawBody: string, secret: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

/** Placeholder webhook secrets that must never run a real server (examples, docs, tutorials). */
export const KNOWN_DEFAULT_WEBHOOK_SECRETS = new Set([
  "", "whsec_", "whsec_test", "whsec_xxx", "whsec_123", "whsec_...", "whsec_placeholder", "whsec_changeme",
  "secret", "changeme", "test", "password",
]);

/**
 * Startup check (outside DEMO_MODE): the webhook secret must be set, not a known placeholder, at least 24 characters,
 * and not one of the server's own simulated secrets. In DEMO_MODE the simulated checkout signs with a random secret.
 */
export function assertWebhookSecret(secret: string | undefined, demoMode: boolean): void {
  if (demoMode) return;
  const s = (secret ?? "").trim();
  if (KNOWN_DEFAULT_WEBHOOK_SECRETS.has(s) || s.length < 24 || s.startsWith("whsec_simulated_")) {
    throw new Error("STRIPE_WEBHOOK_SECRET is missing or a placeholder. Set the real webhook secret, or run with DEMO_MODE=1 for the simulated checkout.");
  }
}

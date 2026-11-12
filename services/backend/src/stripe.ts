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

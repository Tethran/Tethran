// Strips personal and payment data from untrusted text before it is sent to a model or put in a trace.
// Removes: emails, wallet addresses (unless listed), IBAN-like and card-like numbers, phone numbers and long digit runs.
// Listed payee ids (and listed addresses) are kept untouched.
export interface RedactOptions {
  /** Payee ids that must survive redaction (for example "payee_amara"). */
  keep?: string[];
  /** Wallet addresses that are allowed to appear (case-insensitive). Every other 0x address is removed. */
  allowedAddresses?: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Placeholder: \u0001 + letters (the index in base 26) + \u0002. Letters only, so no rule below can touch it.
const holder = (i: number) => {
  let n = i;
  let l = "";
  do {
    l = String.fromCharCode(97 + (n % 26)) + l;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `\u0001${l}\u0002`;
};
const unhold = (l: string) => l.split("").reduce((n, c) => n * 26 + (c.charCodeAt(0) - 96), 0) - 1;

export function redact(text: string, opts: RedactOptions = {}): string {
  const keep = (opts.keep ?? []).filter((k) => k.length > 0).sort((a, b) => b.length - a.length);
  const allowed = new Set((opts.allowedAddresses ?? []).map((a) => a.toLowerCase()));
  const saved: string[] = [];
  const save = (m: string) => {
    saved.push(m);
    return holder(saved.length - 1);
  };
  let out = text;
  if (keep.length > 0) out = out.replace(new RegExp(keep.map(esc).join("|"), "g"), save);
  out = out.replace(/\b0x[0-9a-fA-F]{40}\b/g, (m) => (allowed.has(m.toLowerCase()) ? save(m) : "[ADDRESS]"));
  out = out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[EMAIL]")
    // IBAN-like: two letters, two digits, then groups of letters or digits (spaces allowed between groups)
    .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g, (m) => (/\d/.test(m.slice(4)) ? "[IBAN]" : m))
    // card-like: 13 to 19 digits, optionally separated by single spaces or dashes
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, "[CARD]")
    // international or separated phone numbers: +234 801 234 5678, (555) 123-4567, 0801-234-5678
    .replace(/\+\d[\d\s().-]{6,}\d/g, "[PHONE]")
    .replace(/\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/g, "[PHONE]")
    // any remaining run of 9 or more digits (account numbers, IDs, unseparated phones)
    .replace(/\d{9,}/g, "[NUMBER]");
  if (saved.length > 0) out = out.replace(/\u0001([a-z]+)\u0002/g, (m, l: string) => saved[unhold(l)] ?? m);
  return out;
}

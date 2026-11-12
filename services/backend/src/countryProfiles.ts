// Country profiles as data (PRD M9, FR-9.1, FR-9.2). Adding a country means adding an entry to PROFILES (or
// loading more entries with registerCountryProfile); no other code changes.
// Tax rates are PLACEHOLDERS to verify with a local tax adviser: every rate carries rates_verified: false.
// Payout rails other than usdt are SIMULATED in this build.
import { ApiError } from "./errors";

export interface TaxIdentifier {
  field: string;        // key used in an invoice's provider_tax_ids, e.g. "TIN"
  label: string;
  required: boolean;
}

export interface TaxRate {
  name: string;
  rate_bps: number;     // basis points; placeholder, see rates_verified
  rates_verified: false;
  note: string;
}

export interface CountryProfile {
  code: string;
  name: string;
  currency: string;                 // local currency (invoices are issued in USD; this is for display and payouts)
  tax_identifiers: TaxIdentifier[];
  required_invoice_fields: string[]; // fields an invoice for this country must carry
  payout_rails: string[];           // subset of mpesa, mtn_momo, airtel, bank, usdt
  tax_rates: TaxRate[];
  rule_sources: string[];           // where the rules come from; to be verified
}

const placeholder = (name: string, rate_bps: number): TaxRate => ({
  name, rate_bps, rates_verified: false, note: "Placeholder rate. Verify against the current local tax rules before use.",
});

const COMMON_FIELDS = ["invoice_number", "issue_date", "due_date", "provider_name", "client_name", "currency", "line_items", "subtotal", "total"];

const PROFILES: Record<string, CountryProfile> = {
  NG: {
    code: "NG", name: "Nigeria", currency: "NGN",
    tax_identifiers: [{ field: "TIN", label: "Tax Identification Number (TIN)", required: true }],
    required_invoice_fields: [...COMMON_FIELDS, "provider_tax_ids.TIN"],
    payout_rails: ["bank", "mtn_momo", "usdt"],
    tax_rates: [placeholder("VAT", 750)],
    rule_sources: ["Federal Inland Revenue Service (to verify)"],
  },
  KE: {
    code: "KE", name: "Kenya", currency: "KES",
    tax_identifiers: [{ field: "KRA_PIN", label: "KRA PIN", required: true }],
    required_invoice_fields: [...COMMON_FIELDS, "provider_tax_ids.KRA_PIN"],
    payout_rails: ["mpesa", "airtel", "bank", "usdt"],
    tax_rates: [placeholder("VAT", 1600)],
    rule_sources: ["Kenya Revenue Authority (to verify)"],
  },
  ZA: {
    code: "ZA", name: "South Africa", currency: "ZAR",
    tax_identifiers: [{ field: "VAT_NUMBER", label: "VAT number", required: false }, { field: "TAX_NUMBER", label: "Income tax reference number", required: false }],
    required_invoice_fields: [...COMMON_FIELDS, "provider_tax_ids.VAT_NUMBER"],
    payout_rails: ["bank", "usdt"],
    tax_rates: [placeholder("VAT", 1500)],
    rule_sources: ["South African Revenue Service (to verify)"],
  },
  GH: {
    code: "GH", name: "Ghana", currency: "GHS",
    tax_identifiers: [{ field: "TIN", label: "Tax Identification Number (TIN)", required: true }],
    required_invoice_fields: [...COMMON_FIELDS, "provider_tax_ids.TIN"],
    payout_rails: ["mtn_momo", "airtel", "bank", "usdt"],
    tax_rates: [placeholder("VAT", 1500)],
    rule_sources: ["Ghana Revenue Authority (to verify)"],
  },
};

export function registerCountryProfile(p: CountryProfile): void {
  PROFILES[p.code.toUpperCase()] = p;
}

export function listCountryProfiles(): CountryProfile[] {
  return Object.values(PROFILES).sort((a, b) => a.code.localeCompare(b.code));
}

export function getCountryProfile(code: unknown): CountryProfile | undefined {
  return typeof code === "string" ? PROFILES[code.toUpperCase()] : undefined;
}

export function requireCountryProfile(code: unknown): CountryProfile {
  const p = getCountryProfile(code);
  if (!p) throw new ApiError(400, `unknown country profile (known: ${Object.keys(PROFILES).join(", ")})`);
  return p;
}

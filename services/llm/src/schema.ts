import Ajv2020 from "ajv/dist/2020";

// SettlementProposal schema, copied exactly from docs/INTERFACES.md section 1.
export const proposalSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SettlementProposal",
  type: "object",
  additionalProperties: false,
  required: ["milestone_id", "confidence", "evidence_used", "actions", "flags", "needs_human"],
  properties: {
    milestone_id: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence_used: { type: "array", items: { type: "string" } },
    actions: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "payee_id", "amount", "asset"],
            properties: {
              type: { const: "payout" },
              payee_id: { type: "string" },
              amount: { type: "string", pattern: "^[0-9]+$" },
              asset: { const: "USDT" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "payee_id", "amount", "provider"],
            properties: {
              type: { const: "mobile_money_payout" },
              payee_id: { type: "string" },
              amount: { type: "string", pattern: "^[0-9]+$" },
              provider: { enum: ["mpesa", "mtn_momo", "airtel", "bank"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "amount", "reason"],
            properties: {
              type: { const: "tax_reserve" },
              amount: { type: "string", pattern: "^[0-9]+$" },
              reason: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "amount", "target", "condition"],
            properties: {
              type: { const: "conversion" },
              amount: { type: "string", pattern: "^[0-9]+$" },
              target: { type: "string" },
              condition: { type: "string" },
            },
          },
        ],
      },
    },
    flags: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "detail"],
        properties: { code: { type: "string" }, detail: { type: "string" } },
      },
    },
    // Delivery check (v0.12): per acceptance criterion, met / unmet / unclear with one short reason. Advisory for the
    // client; at settlement any unmet or unclear criterion escalates the plan (CRITERIA_UNMET / CRITERIA_UNCLEAR).
    delivery_check: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "status", "reason"],
        properties: {
          criterion: { type: "string", maxLength: 500 },
          status: { enum: ["met", "unmet", "unclear"] },
          reason: { type: "string", maxLength: 500 },
        },
      },
    },
    needs_human: { type: "boolean" },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(proposalSchema);

export type SchemaResult = { valid: true } | { valid: false; errors: string[] };

export function validateProposal(input: unknown): SchemaResult {
  if (validate(input)) return { valid: true };
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  return { valid: false, errors };
}

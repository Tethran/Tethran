// The agent's delivery check (v0.12): unmet or unclear criteria escalate (never reject); met changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProposal } from "../src/engine";
import { validateProposal } from "../src/schema";
import { goodProposal, makeCtx } from "./helpers";

const withCheck = (check: unknown[], extra: Record<string, unknown> = {}) => ({ ...goodProposal(), delivery_check: check, ...extra });
const met = (criterion = "Three concepts") => ({ criterion, status: "met", reason: "the files show three concepts" });

test("all criteria met: approved exactly as without a check", () => {
  const r = evaluateProposal(withCheck([met(), met("One refined")]), makeCtx());
  assert.deepEqual([r.decision, r.reasons], ["approved", []]);
});

test("one unmet criterion escalates CRITERIA_UNMET (not rejected)", () => {
  const r = evaluateProposal(withCheck([met(), { criterion: "One refined", status: "unmet", reason: "no refined version delivered" }]), makeCtx());
  assert.deepEqual([r.decision, r.reasons], ["escalated", ["CRITERIA_UNMET"]]);
});

test("evidence silent on a criterion escalates CRITERIA_UNCLEAR; both codes when both happen", () => {
  const unclear = { criterion: "One refined", status: "unclear", reason: "the evidence does not mention it" };
  assert.deepEqual(evaluateProposal(withCheck([unclear]), makeCtx()).reasons, ["CRITERIA_UNCLEAR"]);
  const both = evaluateProposal(withCheck([{ ...unclear, status: "unmet" }, unclear]), makeCtx());
  assert.deepEqual(both.reasons, ["CRITERIA_UNMET", "CRITERIA_UNCLEAR"]);
});

test("a hard rule still rejects; the criteria codes never turn a rejection into an escalation", () => {
  const r = evaluateProposal(withCheck([{ criterion: "x", status: "unmet", reason: "no" }], { actions: [{ type: "payout", payee_id: "payee-9", amount: "1", asset: "USDT" }] }), makeCtx());
  assert.equal(r.decision, "rejected");
});

test("schema: the check is optional; a bad status or an extra field is SCHEMA_INVALID", () => {
  assert.equal(validateProposal(goodProposal()).valid, true);
  assert.equal(validateProposal(withCheck([met()])).valid, true);
  assert.equal(validateProposal(withCheck([{ criterion: "x", status: "probably", reason: "?" }])).valid, false);
  assert.equal(validateProposal(withCheck([{ ...met(), extra: 1 }])).valid, false);
});

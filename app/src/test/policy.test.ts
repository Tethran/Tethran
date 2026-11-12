import { describe, expect, it } from "vitest";
import { checkPolicy, POLICY_CODES, reasonInfo } from "@/api";

describe("landing overspend demo (same rule order as INTERFACES v0.8)", () => {
  it("approves a payment at or under the per-payment limit", () => {
    expect(checkPolicy(500, 500).decision).toBe("APPROVED");
  });
  it("rejects a payment over the per-payment limit with OVER_PER_TX_CAP", () => {
    const r = checkPolicy(501, 500);
    expect(r).toEqual({ decision: "REJECTED", reasons: ["OVER_PER_TX_CAP"] });
  });
  it("rejects a zero payment and a payment above the milestone amount", () => {
    expect(checkPolicy(0, 500).reasons).toEqual(["ZERO_AMOUNT_PAYOUT"]);
    expect(checkPolicy(300, 500, { milestoneAmount: 200 }).reasons).toEqual(["OVER_MILESTONE_AMOUNT"]);
  });
  it("escalates an injected instruction to a human with INJECTION_FLAGGED", () => {
    expect(checkPolicy(10, 500, { injected: true })).toEqual({ decision: "ESCALATED", reasons: ["INJECTION_FLAGGED"] });
  });
  it("a rejection wins over an escalation", () => {
    expect(checkPolicy(900, 500, { injected: true }).decision).toBe("REJECTED");
  });
});

describe("reason codes in plain language", () => {
  it("every Policy Service code from INTERFACES v0.8 has a plain explanation", () => {
    for (const code of [...POLICY_CODES.rejected, ...POLICY_CODES.escalated]) {
      const r = reasonInfo(code);
      expect(r.title.length, code).toBeGreaterThan(3);
      expect(r.plain, code).not.toMatch(/see the service documentation/i);
    }
  });
  it("includes the v0.8 codes", () => {
    expect(POLICY_CODES.rejected).toEqual(expect.arrayContaining(["OVER_MILESTONE_AMOUNT", "ZERO_AMOUNT_PAYOUT"]));
    expect(POLICY_CODES.escalated).toEqual(expect.arrayContaining(["NO_PAYOUTS", "INJECTION_FLAGGED"]));
  });
});

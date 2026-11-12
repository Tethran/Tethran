// The backend names the milestone it is settling and authenticates to the Policy Service (x-internal-token).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPolicyClient } from "../src/policyClient";

test("submitProposal sends the request's milestone id and the internal token", async () => {
  const seen: { headers: Record<string, string>; body: any }[] = [];
  const fakeFetch = (async (_u: URL, init: RequestInit) => {
    seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ decision: "rejected", reasons: ["MILESTONE_ID_MISMATCH"], proposal_hash: "00" }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = createPolicyClient("http://policy.test", "token-0123456789abcdef", fakeFetch);
  const d = await c.submitProposal("ms-1", { milestone_id: "ms-2", actions: [] }, "trace-1");
  assert.equal(d.decision, "rejected");
  assert.equal(seen[0].headers["x-internal-token"], "token-0123456789abcdef");
  assert.equal(seen[0].body.milestone_id, "ms-1"); // the backend's milestone, not the proposal's
  assert.equal(seen[0].body.proposal.milestone_id, "ms-2");
});

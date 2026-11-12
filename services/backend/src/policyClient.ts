// HTTP client for the Policy Service (a separate process with its own key). The backend only asks it for
// decisions; it cannot make the Policy Service sign anything its rules reject.
import { ApiError } from "./errors";

export interface Cosignature {
  action_index: number;
  action_id: string;
  to: string;
  amount: string;
  deadline: number;
  signature: string;
}

export interface PolicyDecision {
  decision: "approved" | "escalated" | "rejected";
  reasons: string[];
  proposal_hash: string;
  cosignatures?: Cosignature[];
  approval_id?: string;
}

export interface PolicyClient {
  submitProposal(proposal: unknown, traceId: string): Promise<PolicyDecision>;
  getPolicy(): Promise<{ policy: Record<string, unknown>; version: number }>;
}

export function createPolicyClient(baseUrl: string, fetchImpl: typeof fetch = fetch): PolicyClient {
  async function call(method: string, path: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ApiError(502, "Policy Service unreachable", "POLICY_UNREACHABLE");
    }
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(502, `Policy Service returned ${res.status} without JSON`, "POLICY_BAD_RESPONSE");
    }
    if (!res.ok) throw new ApiError(502, `Policy Service error ${res.status}: ${String(json.error ?? "").slice(0, 200)}`, "POLICY_ERROR");
    return json;
  }
  return {
    submitProposal: (proposal, traceId) => call("POST", "/v1/proposals", { proposal, trace_id: traceId }),
    getPolicy: () => call("GET", "/v1/policy"),
  };
}

// HTTP routes for contracts, country profiles and invoicing, in the shape of `routes` in http.ts:
// [method, RegExp, handler]. The main session registers them. No chain, no Stripe, no email.
import type { IncomingMessage } from "node:http";
import { createContract, getContract, getContractRow, listContractMilestones, listContracts, signContract, signingPayload, updateContract } from "./contracts";
import { getCountryProfile, listCountryProfiles } from "./countryProfiles";
import { ApiError } from "./errors";
import {
  activateInvoice, activateMilestone, createInvoice, getInvoice, listInvoices, parseNow, payPayload, receipt, runRecurring, runReminders,
  type InvoiceEnv,
} from "./invoices";

export type ContractRouteHandler = (ctx: { params: Record<string, string>; body: any; raw: string; req: IncomingMessage; url: URL }) => Promise<unknown>;
export type ContractRoute = [string, RegExp, ContractRouteHandler];
export type ContractDeps = InvoiceEnv;

export function contractRoutes(deps: ContractDeps): ContractRoute[] {
  const { db } = deps;
  const milestoneOf = (contractId: string, mid: string) => {
    getContractRow(db, contractId);
    const m = listContractMilestones(db, contractId).find((x) => x.id === mid);
    if (!m) throw new ApiError(404, "milestone not found in this contract");
    return m;
  };
  return [
    ["POST", /^\/contracts$/, async ({ body }) => createContract(db, body, deps.now())],
    ["GET", /^\/contracts$/, async ({ url }) => listContracts(db, { provider_id: url.searchParams.get("provider_id"), status: url.searchParams.get("status") })],
    ["GET", /^\/contracts\/([^/]+)$/, async ({ params }) => getContract(db, params[1])],
    ["PATCH", /^\/contracts\/([^/]+)$/, async ({ params, body }) => updateContract(db, params[1], body)],
    ["GET", /^\/contracts\/([^/]+)\/typed-data$/, async ({ params, url }) => {
      const party = url.searchParams.get("party");
      if (party !== "provider" && party !== "client") throw new ApiError(400, 'party must be "provider" or "client"');
      return signingPayload(db, params[1], party);
    }],
    ["POST", /^\/contracts\/([^/]+)\/sign$/, async ({ params, body }) => signContract(db, params[1], body, deps.now())],
    ["GET", /^\/contracts\/([^/]+)\/milestones$/, async ({ params }) => {
      getContractRow(db, params[1]);
      return { milestones: listContractMilestones(db, params[1]) };
    }],
    ["POST", /^\/contracts\/([^/]+)\/milestones\/([^/]+)\/activate$/, async ({ params }) => {
      milestoneOf(params[1], params[2]);
      return activateMilestone(deps, params[1], params[2]);
    }],

    ["GET", /^\/country-profiles$/, async () => ({ profiles: listCountryProfiles() })],
    ["GET", /^\/country-profiles\/([^/]+)$/, async ({ params }) => {
      const p = getCountryProfile(params[1]);
      if (!p) throw new ApiError(404, "country profile not found");
      return p;
    }],

    ["POST", /^\/milestones\/([^/]+)\/invoice$/, async ({ params, body }) => createInvoice(deps, params[1], body ?? {})],
    ["GET", /^\/pay\/([^/]+)$/, async ({ params }) => payPayload(deps, params[1])],
    ["POST", /^\/invoices\/recurring\/run$/, async ({ body }) => runRecurring(deps, parseNow(body, deps.now()))],
    ["POST", /^\/invoices\/reminders\/run$/, async ({ body }) => runReminders(deps, parseNow(body, deps.now()))],
    ["GET", /^\/invoices$/, async ({ url }) => ({
      invoices: listInvoices(deps, { status: url.searchParams.get("status"), provider_id: url.searchParams.get("provider_id") }),
    })],
    ["GET", /^\/invoices\/([^/]+)$/, async ({ params }) => getInvoice(deps, params[1])],
    ["GET", /^\/invoices\/([^/]+)\/receipt$/, async ({ params }) => receipt(deps, params[1])],
    ["POST", /^\/invoices\/([^/]+)\/activate$/, async ({ params }) => activateInvoice(deps, params[1])],
  ];
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { canonicalJson, contractHash, parseTerms } from "../src/contracts";
import { getCountryProfile, listCountryProfiles, registerCountryProfile } from "../src/countryProfiles";
import { clientWallet, contractBody, expectApi, insertEscrowRow, providerWallet, setup, sign, signBoth, signedContract } from "./contractFixtures";

// ---- creation and validation ----

test("create: returns the contract with milestones (UUIDs, draft state) and a keccak256 hash", async () => {
  const { call } = setup();
  const c = await call("POST", "/contracts", contractBody());
  assert.equal(c.status, "draft");
  assert.equal(c.hash_algorithm, "keccak256");
  assert.match(c.contract_hash, /^0x[0-9a-f]{64}$/);
  assert.equal(c.milestones.length, 2);
  for (const m of c.milestones) { assert.match(m.id, /^[0-9a-f-]{36}$/); assert.equal(m.state, "draft"); }
  const again = await call("GET", `/contracts/${c.id}`);
  assert.equal(again.contract_hash, c.contract_hash);
  const list = await call("GET", `/contracts/${c.id}/milestones`);
  assert.deepEqual(list.milestones.map((m: any) => m.title), ["Brand identity pack", "Website design"]);
});

test("create: validation of amounts, country, currency, parties, dates", async () => {
  const { call } = setup();
  const ms = (over: object) => [{ title: "t", amount_usd_cents: 100, acceptance_criteria: "c", due_date: "2026-03-15", ...over }];
  for (const amount of [0, -5, 10.5, "100", null]) await expectApi(call("POST", "/contracts", contractBody({ milestones: ms({ amount_usd_cents: amount }) })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ country: "XX" })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ currency: "EUR" })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ milestones: [] })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ milestones: ms({ due_date: "2026-02-31" }) })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ milestones: ms({ acceptance_criteria: "" }) })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ provider_id: undefined })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ client_name: undefined })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ provider_address: "0x12" })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ client_address: undefined })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ client_address: providerWallet.address })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ client_email: "nope" })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ recurrence: { frequency: "daily", count: 3 } })), 400);
  await expectApi(call("POST", "/contracts", contractBody({ recurrence: { frequency: "monthly" } })), 400);
  await expectApi(call("GET", "/contracts/nope", undefined), 404);
});

// ---- hash ----

test("hash: stable under key reordering, changes with any term", () => {
  const terms = parseTerms({ ...contractBody(), milestones: [{ id: "11111111-1111-4111-8111-111111111111", title: "A", amount_usd_cents: 100, acceptance_criteria: "c", due_date: "2026-03-15" }] });
  const h = contractHash(terms);
  const rev = (x: any): any => Array.isArray(x) ? x.map(rev) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, rev(v)])) : x;
  const reordered = rev(terms);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(terms));
  assert.equal(contractHash(reordered), h);
  assert.equal(canonicalJson({ b: 1, a: { d: 1, c: undefined } }), '{"a":{"d":1},"b":1}');
  assert.equal(h, keccak256(toUtf8Bytes(canonicalJson(terms))));
  const change = (f: (t: any) => void) => { const t = structuredClone(terms) as any; f(t); return contractHash(t); };
  const variants = [
    change((t) => (t.milestones[0].amount_usd_cents = 101)), change((t) => (t.milestones[0].title = "B")),
    change((t) => (t.milestones[0].acceptance_criteria = "d")), change((t) => (t.milestones[0].due_date = "2026-03-16")),
    change((t) => (t.client_name = "X")), change((t) => (t.country = "KE")), change((t) => (t.client_address = providerWallet.address)),
    change((t) => (t.provider_id = "p2")), change((t) => (t.recurrence = { frequency: "weekly", count: 2 })),
    change((t) => t.milestones.push({ ...t.milestones[0], id: "22222222-2222-4222-8222-222222222222" })),
  ];
  for (const v of variants) assert.notEqual(v, h);
  assert.equal(new Set(variants).size, variants.length);
});

// ---- signing ----

test("sign: both parties sign the same hash, the contract becomes signed; re-signing is idempotent", async () => {
  const s = setup();
  const c = await s.call("POST", "/contracts", contractBody());
  const p = await s.call("POST", `/contracts/${c.id}/sign`, { party: "provider", signer: providerWallet.address, signature: await sign(providerWallet, c.contract_hash, "provider") });
  assert.equal(p.status, "draft");
  assert.equal(p.signatures.length, 1);
  s.clock.t = new Date("2026-03-02T00:00:00Z");
  const done = await signBoth(s.call, c);
  assert.equal(done.status, "signed");
  assert.equal(done.signed_at, "2026-03-02T00:00:00.000Z");
  assert.equal(done.signatures.length, 2);
  s.clock.t = new Date("2026-03-09T00:00:00Z");
  const again = await signBoth(s.call, c);
  assert.equal(again.signed_at, "2026-03-02T00:00:00.000Z");
  assert.deepEqual(again.signatures, done.signatures);
});

test("sign: wrong signer, wrong party, other hash, wrong domain and malformed input are refused", async () => {
  const s = setup();
  const c = await s.call("POST", "/contracts", contractBody());
  const post = (b: object) => s.call("POST", `/contracts/${c.id}/sign`, b);
  const stranger = Wallet.createRandom();
  // signer field is not the party's wallet
  await expectApi(post({ party: "provider", signer: stranger.address, signature: await sign(stranger, c.contract_hash, "provider") }), 400, "WRONG_SIGNER");
  // right wallet, but the party is the other one
  await expectApi(post({ party: "client", signer: providerWallet.address, signature: await sign(providerWallet, c.contract_hash, "client") }), 400, "WRONG_SIGNER");
  // signature made by a stranger while claiming the provider address
  await expectApi(post({ party: "provider", signer: providerWallet.address, signature: await sign(stranger, c.contract_hash, "provider") }), 400, "BAD_SIGNATURE");
  // provider signed the message for party "client" but submits it as provider
  await expectApi(post({ party: "provider", signer: providerWallet.address, signature: await sign(providerWallet, c.contract_hash, "client") }), 400, "BAD_SIGNATURE");
  // signature over another hash
  const other = keccak256(toUtf8Bytes("other"));
  await expectApi(post({ party: "provider", signer: providerWallet.address, signature: await sign(providerWallet, other, "provider") }), 400, "BAD_SIGNATURE");
  // wrong domain (version, name, and a chain id)
  for (const domain of [{ name: "TethranContract", version: "2" }, { name: "Other", version: "1" }, { name: "TethranContract", version: "1", chainId: 1 }]) {
    await expectApi(post({ party: "provider", signer: providerWallet.address, signature: await sign(providerWallet, c.contract_hash, "provider", domain) }), 400, "BAD_SIGNATURE");
  }
  await expectApi(post({ party: "witness", signer: providerWallet.address, signature: "0x" }), 400);
  await expectApi(post({ party: "provider", signer: providerWallet.address, signature: "0x1234" }), 400);
  assert.equal((await s.call("GET", `/contracts/${c.id}`)).signatures.length, 0);
});

test("typed-data endpoint returns what the wallet must sign", async () => {
  const s = setup();
  const c = await s.call("POST", "/contracts", contractBody());
  const t = await s.call("GET", `/contracts/${c.id}/typed-data?party=client`);
  assert.deepEqual(t.domain, { name: "TethranContract", version: "1" });
  assert.deepEqual(t.message, { contractHash: c.contract_hash, party: "client" });
  const sig = await clientWallet.signTypedData(t.domain, t.types, t.message);
  await s.call("POST", `/contracts/${c.id}/sign`, { party: "client", signer: clientWallet.address, signature: sig });
});

test("terms are frozen once both have signed; a draft edit changes the hash and drops signatures", async () => {
  const s = setup();
  const c = await s.call("POST", "/contracts", contractBody());
  await s.call("POST", `/contracts/${c.id}/sign`, { party: "provider", signer: providerWallet.address, signature: await sign(providerWallet, c.contract_hash, "provider") });
  const edited = await s.call("PATCH", `/contracts/${c.id}`, { client_name: "Kofi Holdings" });
  assert.notEqual(edited.contract_hash, c.contract_hash);
  assert.equal(edited.signatures.length, 0);
  assert.deepEqual(edited.milestones.map((m: any) => m.id), c.milestones.map((m: any) => m.id));
  const done = await signBoth(s.call, edited);
  assert.equal(done.status, "signed");
  await expectApi(s.call("PATCH", `/contracts/${c.id}`, { client_name: "Else" }), 409, "TERMS_FROZEN");
  assert.equal((await s.call("GET", `/contracts/${c.id}`)).contract_hash, edited.contract_hash);
});

// ---- state mapping and activation ----

test("milestone state comes from the escrow milestones table, draft when absent", async () => {
  const s = setup();
  const c = await signedContract(s);
  const [m1, m2] = c.milestones;
  const states = async () => (await s.call("GET", `/contracts/${c.id}/milestones`)).milestones.map((m: any) => m.state);
  assert.deepEqual(await states(), ["draft", "draft"]);
  for (const st of ["draft", "funded", "in_review", "approved", "disputed", "released", "paid_out", "refunded"]) {
    s.db.exec("DELETE FROM milestones");
    insertEscrowRow(s.db, m1.id, st);
    assert.deepEqual(await states(), [st, "draft"], st);
  }
  insertEscrowRow(s.db, m2.id, "funded");
  assert.deepEqual(await states(), ["refunded", "funded"]);
});

test("activate: refused before signing; after signing returns the POST /milestones body", async () => {
  const s = setup();
  const c = await s.call("POST", "/contracts", contractBody());
  const m = c.milestones[0];
  await expectApi(s.call("POST", `/contracts/${c.id}/milestones/${m.id}/activate`), 409, "NOT_SIGNED");
  await signBoth(s.call, c);
  const body = await s.call("POST", `/contracts/${c.id}/milestones/${m.id}/activate`);
  assert.deepEqual(body, {
    id: m.id, provider_id: "prov-1", title: "Brand identity pack", client_address: clientWallet.address,
    amount_usd_cents: 10_000, invoice_ref: "INV-2026-0001",
  });
  assert.deepEqual(await s.call("POST", `/contracts/${c.id}/milestones/${m.id}/activate`), body);
  await expectApi(s.call("POST", `/contracts/${c.id}/milestones/00000000-0000-4000-8000-000000000000/activate`), 404);
});

// ---- country profiles ----

test("country profiles: NG, KE, ZA, GH with tax fields, rails and unverified placeholder rates", async () => {
  const { call } = setup();
  const all = (await call("GET", "/country-profiles")).profiles;
  assert.deepEqual(all.map((p: any) => p.code), ["GH", "KE", "NG", "ZA"]);
  const ke = await call("GET", "/country-profiles/ke");
  assert.equal(ke.currency, "KES");
  assert.ok(ke.tax_identifiers.some((t: any) => t.field === "KRA_PIN"));
  assert.ok(ke.payout_rails.includes("mpesa"));
  for (const p of all) {
    assert.ok(p.tax_rates.length > 0);
    for (const r of p.tax_rates) assert.equal(r.rates_verified, false);
    for (const rail of p.payout_rails) assert.ok(["mpesa", "mtn_momo", "airtel", "bank", "usdt"].includes(rail));
  }
  await expectApi(call("GET", "/country-profiles/XX"), 404);
});

test("adding a country is configuration only", async () => {
  const { call } = setup();
  registerCountryProfile({ code: "TZ", name: "Tanzania", currency: "TZS", tax_identifiers: [{ field: "TIN", label: "TIN", required: true }],
    required_invoice_fields: ["invoice_number", "provider_tax_ids.TIN"], payout_rails: ["bank", "usdt"], tax_rates: [], rule_sources: [] });
  try {
    assert.ok(getCountryProfile("tz"));
    const c = await call("POST", "/contracts", contractBody({ country: "TZ" }));
    assert.equal(c.country, "TZ");
  } finally {
    assert.ok(listCountryProfiles().length >= 5);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "../src/errors";
import { createPhoneRegistry, hashPhone, maskPhone, migratePhoneRegistry, normalisePhone, phoneRegistryRoutes } from "../src/phoneRegistry";

const WALLET = "0x00000000000000000000000000000000000000b2";
const OTHER = "0x00000000000000000000000000000000000000b3";
const PHONE = "+2348012344567";

function setup() {
  const db = new DatabaseSync(":memory:");
  migratePhoneRegistry(db);
  const now = () => new Date("2026-11-12T10:00:00Z");
  return { db, reg: createPhoneRegistry({ db, now, salt: "test-salt" }), now };
}
const reg1 = (extra: Record<string, unknown> = {}) => ({ phone: PHONE, rail: "mpesa", wallet_address: WALLET, consent: true, ...extra });

test("normalisation: spaces, dashes and 00 prefix; rejects non E.164", () => {
  assert.equal(normalisePhone("+234 801-234-4567"), PHONE);
  assert.equal(normalisePhone("00234 (801) 2344567"), PHONE);
  for (const bad of ["08012344567", "+0123456789", "+12", "abc", 5, undefined]) assert.throws(() => normalisePhone(bad), ApiError);
});

test("masking: +234•••••4567", () => assert.equal(maskPhone(PHONE), "+234•••••4567"));

test("hash is keyed by the salt and is not the number", () => {
  assert.notEqual(hashPhone(PHONE, "a"), hashPhone(PHONE, "b"));
  assert.match(hashPhone(PHONE, "a"), /^[0-9a-f]{64}$/);
});

test("consent is required to register", () => {
  const { reg } = setup();
  for (const consent of [undefined, false, "true", 1]) {
    assert.throws(() => reg.register(reg1({ consent })), (e: unknown) => e instanceof ApiError && e.code === "CONSENT_REQUIRED");
  }
});

test("no plain phone number is stored anywhere, nor returned", () => {
  const { db, reg } = setup();
  const out = reg.register(reg1());
  assert.equal(out.phone_masked, "+234•••••4567");
  const resolved = reg.resolve({ phone: PHONE });
  const dump = JSON.stringify([
    db.prepare("SELECT * FROM phone_registry").all(), out, resolved,
    db.prepare("SELECT name, sql FROM sqlite_master").all(),
  ]);
  assert.ok(!dump.includes("2348012344567"));
  assert.ok(!dump.includes("8012344567"));
  assert.ok(!JSON.stringify([out, resolved]).includes(WALLET), "resolve and register never show the address");
});

test("resolve: masked, rail and consent; unknown numbers are not registered", () => {
  const { reg } = setup();
  reg.register(reg1());
  const r = reg.resolve({ phone: "+234 801 234 4567" });
  assert.deepEqual([r.registered, r.consented, r.rail, r.phone_masked, r.country, r.simulated], [true, true, "mpesa", "+234•••••4567", "NG", true]);
  const none = reg.resolve({ phone: "+254711000111" });
  assert.deepEqual([none.registered, none.consented, none.rail], [false, false, null]);
});

test("registering the same number to another wallet is refused while consent is active", () => {
  const { reg } = setup();
  reg.register(reg1());
  reg.register(reg1()); // same wallet: idempotent
  assert.throws(() => reg.register(reg1({ wallet_address: OTHER })), (e: unknown) => e instanceof ApiError && e.status === 409);
});

test("withdrawal is honoured: wallet erased, resolve and send-to-phone refuse, re-registering works", async () => {
  const { db, reg } = setup();
  const { phone_hash } = reg.register(reg1());
  const w = reg.withdraw(phone_hash);
  assert.equal(w.consented, false);
  const row = db.prepare("SELECT * FROM phone_registry WHERE phone_hash = ?").get(phone_hash) as any;
  assert.deepEqual([row.wallet_address, row.account_ref], [null, null]);
  assert.ok(row.consent_withdrawn_at);
  assert.equal(reg.resolve({ phone: PHONE }).consented, false);
  await assert.rejects(reg.sendToPhone({ phone: PHONE, amount: "1000000" }), (e: unknown) => e instanceof ApiError && e.code === "NOT_REGISTERED");
  assert.throws(() => reg.withdraw("zz"), ApiError);
  assert.throws(() => reg.withdraw("0".repeat(64)), (e: unknown) => e instanceof ApiError && e.status === 404);
  reg.register(reg1({ wallet_address: OTHER }));
  assert.equal(reg.resolve({ phone: PHONE }).consented, true);
});

test("send-to-phone returns a payee object and a simulated quote, and does not send money", async () => {
  const { db, reg } = setup();
  reg.register(reg1({ phone: "+254711000111", rail: "mpesa" }));
  const out: any = await reg.sendToPhone({ phone: "+254711000111", amount: "100000000" });
  assert.equal(out.simulated, true);
  assert.deepEqual([out.payee.address, out.payee.rail, out.payee.simulated, out.payee.verified_name], [WALLET, "mpesa", true, null]);
  assert.match(out.payee.payee_id, /^phone_[0-9a-f]{12}$/);
  assert.deepEqual([out.quote.fee, out.quote.currency], ["1500000", "KES"]);
  assert.ok(!JSON.stringify(out).includes("254711000111"));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM phone_registry").get() as any).n, 1);
  await assert.rejects(reg.sendToPhone({ phone: "+254711000111", amount: "0" }), ApiError);
});

test("routes: register, resolve, send-to-phone and DELETE", async () => {
  const { db, now } = setup();
  const routes = phoneRegistryRoutes({ db, now, salt: "test-salt" });
  const call = (method: string, path: string, body?: unknown) => {
    const r = routes.find(([m, re]) => m === method && re.test(path))!;
    return r[2]({ params: r[1].exec(path) as never, body, url: new URL(path, "http://x") });
  };
  const reg: any = await call("POST", "/phone-registry", reg1());
  assert.equal(((await call("POST", "/phone-registry/resolve", { phone: PHONE })) as any).consented, true);
  assert.equal(((await call("POST", "/send-to-phone", { phone: PHONE, amount: "5000000" })) as any).payee.address, WALLET);
  assert.equal(((await call("DELETE", `/phone-registry/${reg.phone_hash}`)) as any).consented, false);
});

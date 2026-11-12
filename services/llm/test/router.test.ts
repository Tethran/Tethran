import { noopTracer, MemoryTracer as _MT, traceTool } from "../src/tracing.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmProvider, configFromEnv, type LlmConfig } from "../src/router.js";
import { LlmAllFailedError, LlmConfigError } from "../src/errors.js";
import { MemoryTracer } from "../src/tracing.js";
import type { FetchLike } from "../src/types.js";
import { GOOD, KEY, fakeFetch, geminiOk, openAiOk, req, type Reply } from "./helpers.js";

const cfg = (order = ["groq", "gemini"]): LlmConfig => ({
  order,
  groq: { apiKey: KEY, model: "gm" },
  gemini: { apiKey: KEY, model: "mm" },
  nvidia: { apiKey: KEY, model: "nm" },
});

// Routes by URL so each provider gets its own scripted replies.
function routedFetch(groq: Reply[], gemini: Reply[], nvidia: Reply[] = []) {
  const scripts: Record<string, { replies: Reply[]; n: number }> = {
    groq: { replies: groq, n: 0 }, generativelanguage: { replies: gemini, n: 0 }, nvidia: { replies: nvidia, n: 0 },
  };
  const hits: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const key = Object.keys(scripts).find((k) => url.includes(k))!;
    hits.push(key === "generativelanguage" ? "gemini" : key);
    const s = scripts[key]!;
    const inner = fakeFetch([s.replies[Math.min(s.n++, s.replies.length - 1)]!]);
    return inner.fetch(url, init);
  };
  return { fetch, hits };
}

const harness = (groq: Reply[], gemini: Reply[], order?: string[], nvidia: Reply[] = []) => {
  const { fetch, hits } = routedFetch(groq, gemini, nvidia);
  const sleeps: number[] = [];
  const tracer = new MemoryTracer();
  const llm = createLlmProvider(cfg(order), { fetch, tracer, sleep: async (ms) => void sleeps.push(ms) });
  return { llm, hits, sleeps, tracer };
};

test("success on the first try", async () => {
  const h = harness([openAiOk(GOOD)], []);
  const r = await h.llm.complete(req);
  assert.deepEqual(r.parsed, { ok: true });
  assert.equal(r.provider, "groq");
  assert.equal(r.attempts, 1);
  assert.deepEqual(h.hits, ["groq"]);
});

test("invalid JSON then success on the retry (same provider)", async () => {
  const h = harness([openAiOk("not json"), openAiOk(GOOD)], []);
  const r = await h.llm.complete(req);
  assert.deepEqual(r.parsed, { ok: true });
  assert.deepEqual(h.hits, ["groq", "groq"]);
  assert.equal(r.attempts, 2);
});

test("fenced JSON is accepted", async () => {
  const h = harness([openAiOk("```json\n" + GOOD + "\n```")], []);
  assert.deepEqual((await h.llm.complete(req)).parsed, { ok: true });
});

test("schema mismatch twice then next provider", async () => {
  const h = harness([openAiOk('{"ok":"yes"}')], [geminiOk(GOOD)]);
  const r = await h.llm.complete(req);
  assert.deepEqual(h.hits, ["groq", "groq", "gemini"]);
  assert.equal(r.provider, "gemini");
  assert.equal(r.attempts, 3);
});

test("provider error then retry then next provider", async () => {
  const h = harness([{ status: 500 }], [geminiOk(GOOD)]);
  const r = await h.llm.complete(req);
  assert.deepEqual(h.hits, ["groq", "groq", "gemini"]);
  assert.equal(r.provider, "gemini");
});

test("429 honours Retry-After (capped), skips the same-provider retry and falls through", async () => {
  const h = harness([{ status: 429, headers: { "retry-after": "2" } }], [geminiOk(GOOD)]);
  const r = await h.llm.complete(req);
  assert.deepEqual(h.hits, ["groq", "gemini"]);
  assert.deepEqual(h.sleeps, [2000]);
  assert.equal(r.provider, "gemini");

  const h2 = harness([{ status: 429, headers: { "retry-after": "999" } }], [geminiOk(GOOD)]);
  await h2.llm.complete(req);
  assert.deepEqual(h2.sleeps, [5000]);

  const h3 = harness([{ status: 429 }], [geminiOk(GOOD)]);
  await h3.llm.complete(req);
  assert.deepEqual(h3.sleeps, [1000]);
});

test("never more than 3 attempts; all fail gives LlmAllFailedError with 3 records", async () => {
  const h = harness([{ status: 500 }], [{ status: 500 }], ["groq", "gemini", "nvidia"], [openAiOk(GOOD)]);
  await assert.rejects(h.llm.complete(req), (e: unknown) => {
    assert.ok(e instanceof LlmAllFailedError);
    assert.equal(e.attempts.length, 3);
    assert.deepEqual(e.attempts.map((a) => a.attempt), [1, 2, 3]);
    assert.deepEqual(e.attempts.map((a) => a.provider), ["groq", "groq", "gemini"]);
    assert.equal(e.attempts[0]!.model, "gm");
    assert.ok(!e.message.includes(KEY));
    return true;
  });
  assert.equal(h.hits.length, 3);
  assert.ok(!h.hits.includes("nvidia")); // third provider never reached: budget spent
});

test("429 on every provider ends after 2 attempts with no extra calls", async () => {
  const h = harness([{ status: 429 }], [{ status: 429 }], ["groq", "gemini", "nvidia"], [{ status: 429 }]);
  await assert.rejects(h.llm.complete(req), (e: unknown) => e instanceof LlmAllFailedError && e.attempts.length === 3);
  assert.deepEqual(h.hits, ["groq", "gemini", "nvidia"]);
});

test("no sleep after the final attempt", async () => {
  const h = harness([{ status: 500 }], [{ status: 500 }, { status: 429 }]);
  await assert.rejects(h.llm.complete(req));
  assert.deepEqual(h.sleeps, []);
});

test("missing key or model skips that provider with a key-free message", async () => {
  const { fetch, calls } = fakeFetch([geminiOk(GOOD)]);
  const llm = createLlmProvider(
    { order: ["groq", "gemini"], groq: { apiKey: KEY }, gemini: { apiKey: KEY, model: "mm" } },
    { fetch },
  );
  assert.deepEqual(llm.active, ["gemini"]);
  assert.equal(llm.skipped.length, 1);
  assert.ok(llm.skipped[0]!.includes("GROQ_MODEL"));
  assert.ok(!llm.skipped[0]!.includes(KEY));
  const r = await llm.complete(req);
  assert.equal(r.provider, "gemini");
  assert.equal(calls.length, 1);
});

test("nothing configured throws LlmAllFailedError with no attempts", async () => {
  const llm = createLlmProvider({ order: ["groq"] }, { fetch: fakeFetch([]).fetch });
  await assert.rejects(llm.complete(req), (e: unknown) => e instanceof LlmAllFailedError && e.attempts.length === 0);
});

test("unknown provider name is rejected at config time", () => {
  assert.throws(() => createLlmProvider(cfg(["groq", "openai"]), { fetch: fakeFetch([]).fetch }), LlmConfigError);
  assert.throws(() => createLlmProvider(configFromEnv({ LLM_PROVIDER_ORDER: "bogus" }), { fetch: fakeFetch([]).fetch }), /bogus/);
});

test("configFromEnv reads names from the environment", () => {
  const c = configFromEnv({ LLM_PROVIDER_ORDER: "Groq, gemini", GROQ_API_KEY: "a", GROQ_MODEL: "b", LLM_TIMEOUT_MS: "5000" });
  assert.deepEqual(c.order, ["groq", "gemini"]);
  assert.equal(c.groq?.model, "b");
  assert.equal(c.timeoutMs, 5000);
});

test("tracer is called once per attempt with attempt numbers 1..n and no secrets", async () => {
  const h = harness([openAiOk("nope"), openAiOk('{"ok":1}')], [geminiOk(GOOD)]);
  await h.llm.complete(req);
  assert.deepEqual(h.tracer.records.map((r) => r.attempt), [1, 2, 3]);
  assert.deepEqual(h.tracer.records.map((r) => r.ok), [false, false, true]);
  assert.deepEqual(h.tracer.records.map((r) => r.provider), ["groq", "groq", "gemini"]);
  assert.equal(h.tracer.records[0]!.errorKind, "invalid_json");
  assert.equal(h.tracer.records[1]!.errorKind, "schema_mismatch");
  assert.ok(!JSON.stringify(h.tracer.records).includes(KEY));
});

test("a throwing tracer does not change the outcome", async () => {
  const { fetch } = fakeFetch([openAiOk(GOOD)]);
  const llm = createLlmProvider(cfg(), { fetch, tracer: { ...noopTracer, traceCall() { throw new Error("boom"); } } });
  assert.deepEqual((await llm.complete(req)).parsed, { ok: true });
});

test("each run is one trace; attempts and tool calls inside it become its spans", async () => {
  const tracer = new _MT();
  const { fetch } = fakeFetch([openAiOk("not json"), openAiOk(GOOD)]);
  const llm = createLlmProvider(cfg(), { fetch, tracer });
  const { traceId, result } = await tracer.run({ name: "settle" }, async () => {
    await traceTool("get_milestone", { input: { id: "m-1" }, output: () => ({ found: true }) }, async () => 1);
    return llm.complete(req);
  });
  assert.deepEqual(result.parsed, { ok: true });
  assert.equal(tracer.runs.length, 1);
  assert.equal(tracer.runs[0].traceId, traceId);
  assert.deepEqual(tracer.runs[0].spans.map((s) => [s.type, s.name]), [
    ["tool", "get_milestone"], ["llm", "groq.complete#1"], ["llm", "groq.complete#2"],
  ]);
  assert.equal(tracer.runs[0].spans[1].error, "invalid_json");
});

test("a tool call that throws is recorded as an error span and still throws", async () => {
  const tracer = new _MT();
  await assert.rejects(tracer.run({ name: "x" }, () => traceTool("buy_fx_quote", {}, async () => { throw new TypeError("no"); })));
  assert.equal(tracer.runs[0].spans[0].error, "TypeError");
});

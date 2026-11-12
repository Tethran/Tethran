import { test } from "node:test";
import assert from "node:assert/strict";
import { createGroqAdapter, GROQ_URL } from "../src/providers/groq.js";
import { createGeminiAdapter } from "../src/providers/gemini.js";
import { createNvidiaAdapter, NVIDIA_URL } from "../src/providers/nvidia.js";
import { ProviderError, parseRetryAfter } from "../src/errors.js";
import { GOOD, KEY, fakeFetch, geminiOk, openAiOk, req } from "./helpers.js";

test("groq builds the right request and maps the response", async () => {
  const { fetch, calls } = fakeFetch([openAiOk(GOOD)]);
  const out = await createGroqAdapter({ apiKey: KEY, model: "groq-model-x", fetch }).complete(req);
  const c = calls[0]!;
  assert.equal(c.url, GROQ_URL);
  assert.equal(c.headers.authorization, `Bearer ${KEY}`);
  assert.equal(c.body.model, "groq-model-x");
  assert.equal(c.body.temperature, 0);
  assert.deepEqual(c.body.response_format, { type: "json_object" });
  assert.equal(c.body.messages[0].role, "system");
  assert.equal(c.body.messages[1].content, "hi");
  assert.equal(out.text, GOOD);
  assert.deepEqual(out.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(out.provider, "groq");
  assert.equal(out.model, "groq-model-x");
  assert.equal(out.parsed, undefined); // adapters do not parse; the router does
});

test("nvidia uses its endpoint and JSON mode", async () => {
  const { fetch, calls } = fakeFetch([openAiOk(GOOD)]);
  const out = await createNvidiaAdapter({ apiKey: KEY, model: "nv-m", fetch }).complete(req);
  assert.equal(calls[0]!.url, NVIDIA_URL);
  assert.equal(calls[0]!.body.response_format.type, "json_object");
  assert.equal(out.provider, "nvidia");
});

test("gemini builds the right request: key in header not URL, JSON mime type", async () => {
  const { fetch, calls } = fakeFetch([geminiOk(GOOD)]);
  const out = await createGeminiAdapter({ apiKey: KEY, model: "gem-model-y", fetch }).complete({
    ...req,
    messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }],
  });
  const c = calls[0]!;
  assert.ok(c.url.includes("/models/gem-model-y:generateContent"));
  assert.ok(!c.url.includes(KEY) && !c.url.includes("key="));
  assert.equal(c.headers["x-goog-api-key"], KEY);
  assert.equal(c.body.generationConfig.temperature, 0);
  assert.equal(c.body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(c.body.contents.map((m: any) => m.role), ["user", "model"]);
  assert.ok(c.body.systemInstruction.parts[0].text.startsWith("sys"));
  assert.equal(out.text, GOOD);
  assert.deepEqual(out.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(out.provider, "gemini");
});

test("HTTP errors carry status and Retry-After, and never leak the key, URL or body", async () => {
  const { fetch } = fakeFetch([{ status: 429, headers: { "Retry-After": "2" }, text: `body mentions ${KEY}` }]);
  for (const make of [createGroqAdapter, createGeminiAdapter, createNvidiaAdapter]) {
    await assert.rejects(
      make({ apiKey: KEY, model: "m", fetch }).complete(req),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.status, 429);
        assert.equal(e.retryAfterMs, 2000);
        const shown = `${e.message} ${e.stack ?? ""}`;
        assert.ok(!shown.includes(KEY));
        assert.ok(!/https?:\/\//.test(e.message));
        return true;
      },
    );
  }
});

test("network errors with a key and URL in the message are sanitised", async () => {
  const { fetch } = fakeFetch([{ throw: new Error(`connect failed https://x.example/?key=${KEY}`) }]);
  await assert.rejects(createGroqAdapter({ apiKey: KEY, model: "m", fetch }).complete(req), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.kind, "network");
    assert.ok(!e.message.includes(KEY) && !e.message.includes("http"));
    return true;
  });
});

test("timeout aborts the request", async () => {
  const fetch = ((_u: string, init: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as never;
  await assert.rejects(createGroqAdapter({ apiKey: KEY, model: "m", fetch, timeoutMs: 20 }).complete(req), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.kind, "timeout");
    return true;
  });
});

test("empty reply is an error", async () => {
  const { fetch } = fakeFetch([{ json: { choices: [] } }]);
  await assert.rejects(createGroqAdapter({ apiKey: KEY, model: "m", fetch }).complete(req), /empty reply/);
});

test("parseRetryAfter handles seconds, dates and junk", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
});

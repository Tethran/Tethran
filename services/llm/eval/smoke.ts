// One real call to the configured provider order, to confirm a model works and returns schema-valid JSON.
//   npm run smoke
// Reads LLM_PROVIDER_ORDER and the provider keys and models from the environment. Prints no key and no URL.
// Sends only a fixed, harmless prompt.
import { createLlmProvider, configFromEnv } from "../src/router.js";
import { LlmAllFailedError } from "../src/errors.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "sum"],
  properties: { status: { const: "ok" }, sum: { type: "integer" } },
};

async function main() {
  const llm = createLlmProvider(configFromEnv(), { fetch: globalThis.fetch as never });
  try {
    const r = await llm.complete({
      system: "You are a test endpoint. Reply with JSON only.",
      messages: [{ role: "user", content: 'Return {"status":"ok","sum":N} where N is 19 + 23.' }],
      jsonSchema: schema,
      temperature: 0,
    });
    const valid = r.parsed !== undefined;
    console.log(`provider=${r.provider} model=${r.model} latencyMs=${r.latencyMs} schemaValid=${valid}`);
    console.log(`reply=${r.text.replace(/\s+/g, " ").slice(0, 120)}`);
    console.log(`usage in=${r.usage.inputTokens} out=${r.usage.outputTokens}`);
    process.exit(valid ? 0 : 1);
  } catch (e) {
    if (e instanceof LlmAllFailedError) {
      console.log("FAILED: every attempt failed");
      for (const a of e.attempts) console.log(`  attempt ${a.attempt} ${a.provider} ${a.model}: ${a.reason}`);
    } else {
      console.log(`FAILED: ${(e as Error).name}: ${(e as Error).message.slice(0, 200)}`);
    }
    process.exit(1);
  }
}

main();

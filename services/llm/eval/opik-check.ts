// Sends one small test trace to Opik and reads it back, to prove the key, workspace and project work.
//   npm run opik:check
// Reads OPIK_API_KEY, OPIK_WORKSPACE and OPIK_PROJECT_NAME (default "tethran") from the environment.
// Prints the project name and the trace id, never the key. The trace carries no prompt and no personal data.
import { randomUUID } from "node:crypto";
import { Opik } from "opik";

async function main() {
  const apiKey = process.env.OPIK_API_KEY;
  const workspaceName = process.env.OPIK_WORKSPACE;
  const projectName = process.env.OPIK_PROJECT_NAME || "tethran";
  if (!apiKey || !workspaceName) throw new Error("OPIK_API_KEY and OPIK_WORKSPACE must be set");

  const client = new Opik({ apiKey, workspaceName, projectName });
  const marker = randomUUID();
  const trace = client.trace({
    name: "opik.check",
    input: { check: "connectivity" },
    output: { ok: true },
    metadata: { marker, source: "services/llm opik:check" },
    tags: ["check"],
  });
  const span = trace.span({ name: "opik.check.span", type: "general", input: { step: 1 }, output: { step: 1 } });
  span.end();
  trace.end();
  await client.flush();

  const found = await client.searchTraces({
    projectName,
    filterString: `metadata.marker = "${marker}"`,
    waitForAtLeast: 1,
    waitForTimeout: 60,
  });
  if (found.length !== 1) throw new Error(`expected 1 trace back, got ${found.length}`);
  console.log(`OK: trace written and read back. workspace=${workspaceName} project=${projectName} trace_id=${found[0].id}`);
}

main().catch((e) => {
  const msg = String((e as Error)?.message ?? e).replace(/\b(?:https?):\/\/[^\s"']+/g, "[url removed]");
  console.error(`FAILED: ${(e as Error)?.name ?? "Error"}: ${msg.slice(0, 300)}`);
  process.exit(1);
});

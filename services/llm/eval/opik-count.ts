// Counts the eval traces in the Opik project from the last hour. Prints counts and names only.
import { Opik } from "opik";
const projectName = process.env.OPIK_PROJECT_NAME || "tethran";
const client = new Opik({ apiKey: process.env.OPIK_API_KEY!, workspaceName: process.env.OPIK_WORKSPACE!, projectName });
const since = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
client.searchTraces({ projectName, filterString: `start_time >= "${since}"`, maxResults: 200 }).then((ts: any[]) => {
  const evals = ts.filter((t) => String(t.name).startsWith("eval."));
  console.log(`project=${projectName} traces in the last hour: ${ts.length}, eval traces: ${evals.length}`);
  for (const t of evals.slice(0, 12)) console.log(`  ${t.name} spans=${t.spanCount ?? t.span_count ?? "?"} id=${t.id}`);
  process.exit(0);
}).catch((e: Error) => { console.log("FAILED:", e.name); process.exit(1); });

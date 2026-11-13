// POST /jobs/run: the hourly jobs for a host's cron. Disabled without JOBS_TOKEN; needs the exact x-jobs-token.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/http";
import { harness } from "./helpers";

async function serve(extra: Record<string, unknown>) {
  const h = harness();
  const server = createHttpServer({ db: h.db, treasury: h.treasury, orchestrator: h.orchestrator, now: h.now, ...extra } as never);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const run = (token?: string) => fetch(base + "/jobs/run", { method: "POST", headers: token === undefined ? {} : { "x-jobs-token": token } });
  return { run, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("POST /jobs/run runs the jobs once with the right token; refuses a wrong or missing token; disabled without one", async () => {
  let runs = 0;
  const runJobs = async () => { runs++; return { reminders: "ok" }; };

  const off = await serve({ runJobs, jobsToken: "" });
  assert.equal((await off.run("anything")).status, 404);
  await off.close();

  const on = await serve({ runJobs, jobsToken: "cron-secret-123" });
  assert.equal((await on.run()).status, 401);
  assert.equal((await on.run("wrong")).status, 401);
  const ok = await on.run("cron-secret-123");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { reminders: "ok" });
  assert.equal(runs, 1);
  await on.close();
});

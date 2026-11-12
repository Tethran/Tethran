// Every screen at this project's width: a full-page screenshot, and no sideways scrolling.
import { expect, test } from "@playwright/test";
import { api, overflow, settled, shot } from "./helpers";

test("tour of every screen", async ({ page }) => {
  const [paid, invoices] = await Promise.all([api("/milestones?state=paid_out"), api("/invoices")]);
  const paidId: string | undefined = paid.milestones[0]?.id;
  const unpaid = invoices.invoices.find((i: any) => i.status === "unpaid") ?? invoices.invoices[0];
  const screens: [string, string][] = [
    ["landing", "/"],
    ["trust", "/trust"],
    ["roles", "/app"],
    ["dashboard", "/app/dashboard"],
    ["contract-new", "/app/contracts/new"],
    ["operator", "/app/operator"],
    ["arbiter", "/app/arbiter"],
    ["ledger", "/app/reconciliation"],
    ["send", "/app/send"],
    ["settings", "/app/settings"],
    ...(unpaid ? [["invoice", `/app/invoice/${unpaid.id}`], ["pay", `/pay/${unpaid.id}`]] as [string, string][] : []),
    ...(paidId ? [["milestone-paid", `/app/milestone/${paidId}`], ["receipt", `/receipt/${paidId}`]] as [string, string][] : []),
  ];
  const problems: string[] = [];
  for (const [name, path] of screens) {
    await page.goto(path);
    await settled(page);
    // The error block means the API failed: a real problem for the demo.
    await expect(page.getByText("We couldn't reach the server.")).toHaveCount(0);
    await shot(page, name);
    for (const p of await overflow(page)) problems.push(`${name}: ${p}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

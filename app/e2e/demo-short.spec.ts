// The SHORT demo for the video (target under 2m45s of screen time), against the live demo on Sepolia (test network):
//   create contract -> client pays (test USDT, WDK wallet) -> client approves -> the agent proposes, the Policy Service
//   approves, the vault pays, the receipt is minted and verified -> the vault refuses an over-limit payout -> the
//   wrong network is blocked and the duplicate send refused -> an escalation waits in the operator queue.
// Every wait for the chain is recorded in e2e-artifacts/demo-short-marks.json; e2e/cut-video.mjs then speeds those
// waits up to about a second each and writes e2e-artifacts/recordings/tethran-demo-short.webm. Nothing is cut that is
// not a wait. Signing uses the labelled DEMO_MODE demo keys; the client signs with its WDK wallet.
import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { caption, createContract, pay, settled, shot } from "./helpers";

test("the short demo", async ({ page }) => {
  const t0 = Date.now();
  const waits: [number, number][] = [];
  /** A wait for the chain or a service: sped up in the cut. */
  const wait = async (fn: () => Promise<unknown>) => {
    const s = Date.now();
    await fn();
    waits.push([(s - t0) / 1000, (Date.now() - t0) / 1000]);
  };
  /** Time for a viewer to read what is on screen. */
  const hold = (ms = 2200) => page.waitForTimeout(ms);
  const n = { i: 0 };
  const snap = (name: string) => shot(page, `demo-short-${String(++n.i).padStart(2, "0")}-${name}`);
  const say = async (text: string, ms?: number) => { await caption(page, text); await hold(ms); };

  // 1. Freelancer creates a contract and signs it.
  let invoiceId = "";
  let milestoneId = "";
  await caption(page, "1 · The freelancer writes a contract with one milestone");
  await wait(async () => {
    ({ invoiceId, milestoneId } = await createContract(page, async () => { await hold(1500); await snap("contract"); }));
  });
  await say("The contract is signed; the invoice is ready to share");
  await snap("invoice");

  // 2. Client pays in test USDT from the WDK wallet; the escrow is funded on-chain.
  await pay(page, invoiceId, "Stablecoin", async (confirm) => { await say("2 · The client pays in test USDT from their WDK wallet", 600); await wait(confirm); });
  await say("Funds are locked in the escrow contract on Sepolia");
  await snap("funds-locked");

  // 3. Client approves on-chain.
  await wait(async () => { await page.goto(`/app/milestone/${milestoneId}`); await settled(page); });
  await say("3 · The client approves the work, signed by their wallet", 1500);
  await page.getByRole("button", { name: /Approve work/ }).click();
  await wait(() => expect(page.getByText("Work approved on-chain").first()).toBeVisible({ timeout: 10 * 60_000 }));
  await hold(1200);

  // 4. The agent proposes, the Policy Service approves, the vault pays, the receipt is minted.
  await say("4 · The escrow releases to the vault; the AI proposes how to pay", 1800);
  await page.getByTestId("demo-settle").click();
  await wait(() => expect(page.getByTestId("view-receipt")).toBeVisible({ timeout: 15 * 60_000 }));
  await page.getByTestId("policy-approved").scrollIntoViewIfNeeded();
  await say("The Policy Service checked every rule and co-signed; the vault paid", 3200);
  await snap("settled");
  await page.getByTestId("view-receipt").click();
  await wait(async () => { await page.waitForURL(/\/receipt\//); await settled(page); });
  await say("5 · A receipt NFT is minted. Anyone can verify it", 1500);
  await page.getByRole("button", { name: "Verify" }).click();
  await wait(() => expect(page.getByText("Matches the record on the test network")).toBeVisible({ timeout: 2 * 60_000 }));
  await hold(2500);
  await snap("receipt-verified");

  // 6. The vault refuses an over-limit payout (the limit is enforced on-chain).
  await wait(async () => { await page.goto("/app/operator"); await settled(page); });
  await say("6 · The operator lowers the per-payment limit to $5", 1500);
  await page.getByLabel("New per-payment limit").fill("5");
  await page.getByTestId("change-limit").click();
  await wait(() => expect(page.getByTestId("per-tx-cap")).toHaveText("$5", { timeout: 10 * 60_000 }));
  await caption(page, "A $6 payout is refused by the vault contract itself");
  await page.getByLabel("Test payout amount").fill("6");
  await page.getByTestId("vault-check").click();
  await wait(() => expect(page.getByTestId("vault-check-result")).toContainText("OVER_PER_TX_CAP", { timeout: 2 * 60_000 }));
  await page.getByTestId("vault-check-result").scrollIntoViewIfNeeded();
  await hold(3200);
  await snap("over-limit-refused");
  await caption(page, "Limit restored to $1,000");
  await page.getByLabel("New per-payment limit").fill("1000");
  await page.getByTestId("change-limit").click();
  await wait(() => expect(page.getByTestId("per-tx-cap")).toHaveText("$1,000", { timeout: 10 * 60_000 }));
  await hold(1000);

  // 7. Wrong network blocked, duplicate send refused.
  await wait(async () => { await page.goto("/app/send"); await settled(page); });
  await wait(() => expect(page.getByRole("alert").filter({ hasText: "Wrong network" })).toBeVisible({ timeout: 2 * 60_000 }));
  await say("7 · Wrong network: blocked before anything is signed", 2600);
  await snap("wrong-network");
  await page.getByRole("button", { name: "Switch to the wallet's network" }).click();
  await wait(() => expect(page.getByRole("button", { name: /Confirm and send/ })).toBeEnabled({ timeout: 2 * 60_000 }));
  await caption(page, "Send once, then try the same payment again");
  await page.getByRole("button", { name: /Confirm and send/ }).click();
  await wait(() => expect(page.getByText(/Sent to the network/)).toBeVisible({ timeout: 5 * 60_000 }));
  await page.getByRole("button", { name: /Send again/ }).click();
  await wait(() => expect(page.getByText(/will not be sent twice|not be sent again/).first()).toBeVisible({ timeout: 2 * 60_000 }));
  await say("The duplicate send is refused: it can never pay twice", 2600);
  await snap("duplicate-refused");

  // 8. An escalation waits for a person in the operator queue.
  await wait(async () => { await page.goto("/app/operator"); await settled(page); });
  const queue = page.getByRole("heading", { name: "Needs your decision" });
  await queue.scrollIntoViewIfNeeded();
  await expect(page.getByText(/The AI is not sure|Asked for a person|Over the soft limit|Names don't match|Pays nobody/).first()).toBeVisible();
  await say("8 · Anything unusual escalates to a person, with the reasons in plain language", 3500);
  await snap("escalation-queue");

  writeFileSync("e2e-artifacts/demo-short-marks.json", JSON.stringify({ waits }, null, 2));
});

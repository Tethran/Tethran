// The whole demo, one take, against the live demo on Sepolia (test network). Signing uses the DEMO_MODE
// "Sign with demo key" buttons (labelled in the UI); the client acts through its WDK wallet.
//   Freelancer: creates and signs a contract -> invoice
//   Client:     adds funds to the Tethran wallet (simulated card) -> pays the invoice from the wallet (test USDT) ->
//               escrow funded on-chain -> approves on-chain
//   Clean delivery: the platform releases the escrow to the vault and settles: the agent proposes, the Policy
//               Service decides (with its reasons), the vault pays, the receipt is minted; the receipt page verifies it
//   Card:       a second contract paid by card (simulated checkout) -> funded on-chain, chargeback hold shown
//   Operator:   lowers the per-payment limit (relayed to the vault) -> the vault refuses an over-limit payout ->
//               restores it; decides an escalation (new plan) and an identity hold (release)
//   Arbiter:    votes on the dispute; the client votes the same way -> the escrow decides on-chain
//   Handled failure: send on the wrong network is blocked; the duplicate send is refused
import { expect, test, type Page } from "@playwright/test";
import { addFunds, api, caption, createContract, pay, settled, shot } from "./helpers";

const step = (name: string, fn: () => Promise<void>) => test.step(name, fn);

test("the whole journey", async ({ page }) => {
  let invoiceId = "";
  let milestoneId = "";

  await step("Freelancer: dashboard", async () => {
    await page.goto("/app/dashboard");
    await settled(page);
    await caption(page, "Freelancer: dashboard");
    await shot(page, "journey-01-dashboard");
  });

  await step("Freelancer: create and sign a contract", async () => {
    await caption(page, "Freelancer: a contract with one milestone");
    ({ invoiceId, milestoneId } = await createContract(page, () => shot(page, "journey-02-contract-sign")));
    await settled(page);
    await shot(page, "journey-03-invoice");
  });

  await step("Client: adds funds to the Tethran wallet (simulated card), then pays from the wallet (escrow funded on-chain)", async () => {
    await addFunds(page, "client", 500);
    await caption(page, "Client: $500 added to the Tethran demo wallet by simulated card (test USDT minted)");
    await shot(page, "journey-04a-wallet-funded");
    await pay(page, invoiceId, "Tethran wallet");
    await caption(page, "Client: paid from the Tethran wallet; funds locked in escrow");
    await shot(page, "journey-04-funds-locked");
  });

  await step("Client: approves the work on-chain (WDK wallet)", async () => {
    await page.goto(`/app/milestone/${milestoneId}`);
    await settled(page);
    await caption(page, "Client: approves the work (signed by the client's wallet)");
    await page.getByRole("button", { name: /Approve work/ }).click();
    await expect(page.getByText("Work approved on-chain").first()).toBeVisible({ timeout: 10 * 60_000 });
    await shot(page, "journey-05-approved");
  });

  await step("Clean delivery: release, agent proposal, Policy decision, vault payout, receipt", async () => {
    await caption(page, "Platform: releases the escrow to the vault; the AI proposes; the Policy Service decides");
    await page.getByTestId("demo-settle").click();
    await expect(page.getByTestId("view-receipt")).toBeVisible({ timeout: 15 * 60_000 });
    await expect(page.getByTestId("policy-approved")).toBeVisible();
    await expect(page.getByTestId("vault-payouts")).toContainText("to ");
    await expect(page.getByTestId("fee-line")).toContainText("Platform fee 5%");
    await caption(page, "Approved by the Policy Service; the vault paid the freelancer and Tethran's 5% fee; receipt minted");
    await shot(page, "journey-06-settled");
  });

  await step("Operator: Earnings shows the 5% fee collected", async () => {
    await page.goto("/app/earnings", { waitUntil: "domcontentloaded" });
    await settled(page);
    await expect(page.getByTestId("earnings-lines")).toContainText(/\$\d/);
    await caption(page, "Operator: Tethran's earnings, 5% of each settled milestone (demo earnings account)");
    await shot(page, "journey-06a-earnings");
    await page.goBack();
    await settled(page);
  });

  await step("Receipt: verified against the chain", async () => {
    await page.getByTestId("view-receipt").click();
    await page.waitForURL(/\/receipt\//);
    await settled(page);
    await caption(page, "Receipt: verify it against the test network");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Matches the record on the test network")).toBeVisible({ timeout: 2 * 60_000 });
    await shot(page, "journey-07-receipt-verified");
  });

  await step("Client: a second contract paid by card (simulated checkout); the chargeback hold", async () => {
    await caption(page, "A second contract, paid by card (simulated checkout)");
    const card = await createContract(page);
    await pay(page, card.invoiceId, "Card");
    await page.goto(`/app/milestone/${card.milestoneId}`);
    await settled(page);
    await caption(page, "Card payments wait out a chargeback hold before release");
    await shot(page, "journey-08-card-hold");
  });

  await step("Operator: lower the limit; the vault refuses an over-limit payout; restore", async () => {
    await page.goto("/app/operator");
    await settled(page);
    await caption(page, "Operator: lowers the per-payment limit to $5");
    await shot(page, "journey-09-operator");
    await page.getByLabel("New per-payment limit").fill("5");
    await page.getByTestId("change-limit").click();
    await expect(page.getByTestId("per-tx-cap")).toHaveText("$5", { timeout: 10 * 60_000 });
    await caption(page, "The vault contract refuses a $6 payout");
    await page.getByLabel("Test payout amount").fill("6");
    await page.getByTestId("vault-check").click();
    await expect(page.getByTestId("vault-check-result")).toContainText("Refused by the vault", { timeout: 2 * 60_000 });
    await expect(page.getByTestId("vault-check-result")).toContainText("OVER_PER_TX_CAP");
    await shot(page, "journey-10-vault-refuses");
    await caption(page, "Operator: restores the limit to $1,000");
    await page.getByLabel("New per-payment limit").fill("1000");
    await page.getByTestId("change-limit").click();
    await expect(page.getByTestId("per-tx-cap")).toHaveText("$1,000", { timeout: 10 * 60_000 });
    await page.getByTestId("vault-check").click();
    await expect(page.getByTestId("vault-check-result")).toContainText("The vault would pay", { timeout: 2 * 60_000 });
  });

  await step("Operator: an escalation that pays nobody gets a new plan", async () => {
    const button = page.getByTestId("demo-Request a new plan").first();
    if (await button.count()) {
      await caption(page, "Operator: requests a new plan (it pays nobody, so it can't be approved)");
      await button.click();
      await expect(page.getByText(/New plan requested/).first()).toBeVisible({ timeout: 3 * 60_000 });
      await shot(page, "journey-11-new-plan");
    }
  });

  await step("Operator: releases an identity hold", async () => {
    const button = page.getByTestId("demo-Release").first();
    if (await button.count()) {
      await caption(page, "Operator: releases a held milestone (simulated identity check)");
      await button.click();
      await expect(page.getByText(/Released to the provider's vault/).first()).toBeVisible({ timeout: 10 * 60_000 });
      await shot(page, "journey-12-identity-released");
    }
  });

  await step("Arbiter and client: two of three decide the dispute on-chain", async () => {
    await page.goto("/app/arbiter");
    await settled(page);
    const vote = page.getByTestId("demo-Release to provider").first();
    if (await vote.count()) {
      const disputes = await api<any[]>("/arbiter/disputes");
      const disputed = disputes[0]?.milestone_id as string;
      await caption(page, "Arbiter: votes to release");
      await vote.click();
      await expect(page.getByText(/vote is recorded|Settled on-chain/).first()).toBeVisible({ timeout: 5 * 60_000 });
      await shot(page, "journey-13-arbiter-vote");
      await page.goto(`/app/milestone/${disputed}`);
      await settled(page);
      await caption(page, "Client: votes the same way (WDK wallet); the escrow decides");
      const client = page.getByTestId("client-vote-release");
      if (await client.count()) {
        await client.click();
        await expect(page.getByText("Your vote is recorded.").first()).toBeVisible({ timeout: 10 * 60_000 });
      }
      await page.reload();
      await settled(page);
      await shot(page, "journey-14-dispute-decided");
    }
  });

  await step("Handled failure: wrong network blocked, duplicate send refused", async () => {
    await page.goto("/app/send");
    await settled(page);
    await caption(page, "Send: the wallet is on the wrong network");
    await expect(page.getByRole("alert").filter({ hasText: "Wrong network" })).toBeVisible({ timeout: 2 * 60_000 });
    await shot(page, "journey-15-wrong-network");
    await page.getByRole("button", { name: "Switch to the wallet's network" }).click();
    await expect(page.getByRole("button", { name: /Confirm and send/ })).toBeEnabled({ timeout: 2 * 60_000 });
    await caption(page, "Send once, then try to send the same payment again");
    await page.getByRole("button", { name: /Confirm and send/ }).click();
    await expect(page.getByText(/Sent to the network/)).toBeVisible({ timeout: 5 * 60_000 });
    await page.getByRole("button", { name: /Send again/ }).click();
    await expect(page.getByText(/will not be sent twice|not be sent again/).first()).toBeVisible({ timeout: 2 * 60_000 });
    await shot(page, "journey-16-duplicate-refused");
  });
});

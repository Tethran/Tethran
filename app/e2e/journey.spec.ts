// The whole demo, one take, against the live demo on Sepolia (test network). Signing uses the DEMO_MODE
// "Sign with demo key" buttons (labelled in the UI); the client acts through its WDK wallet.
//   Freelancer: creates and signs a contract -> invoice
//   Client:     pays the invoice (simulated card checkout) -> escrow funded on-chain -> approves on-chain
//   Operator:   lowers the per-payment limit (relayed to the vault) -> the vault refuses an over-limit payout ->
//               restores it; decides an escalation (new plan) and an identity hold (release)
//   Arbiter:    votes on the dispute; the client votes the same way -> the escrow decides on-chain
//   Handled failure: send on the wrong network is blocked; the duplicate send is refused
import { expect, test, type Page } from "@playwright/test";
import { api, settled, shot } from "./helpers";

const step = (name: string, fn: () => Promise<void>) => test.step(name, fn);
const caption = async (page: Page, text: string) => {
  // A visible caption for the recording (removed before the next step).
  await page.evaluate((t) => {
    document.getElementById("e2e-caption")?.remove();
    const d = document.createElement("div");
    d.id = "e2e-caption";
    d.textContent = t;
    Object.assign(d.style, { position: "fixed", left: "16px", bottom: "16px", zIndex: "9999", background: "#0A1F1B", color: "#C6F24E", padding: "8px 14px", borderRadius: "999px", font: "600 14px system-ui", pointerEvents: "none" });
    document.body.appendChild(d);
  }, text);
};

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
    await page.goto("/app/contracts/new");
    await caption(page, "Freelancer: a contract with one milestone");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("checkbox").check();
    await shot(page, "journey-02-contract-sign");
    await page.getByTestId("demo-Sign and send").click();
    await page.waitForURL(/\/app\/invoice\//, { timeout: 5 * 60_000 });
    invoiceId = page.url().split("/app/invoice/")[1]!.split(/[?#]/)[0]!;
    const inv = await api(`/invoices/${invoiceId}`);
    milestoneId = inv.escrow_milestone_id;
    await settled(page);
    await shot(page, "journey-03-invoice");
  });

  await step("Client: pay the invoice (simulated card checkout; the escrow is funded on-chain)", async () => {
    await page.goto(`/pay/${invoiceId}`);
    await caption(page, "Client: pays by card (simulated checkout)");
    await page.getByRole("button", { name: /Confirm and pay/ }).click();
    await expect(page.getByText("Funds locked.")).toBeVisible({ timeout: 10 * 60_000 });
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

  await step("Operator: lower the limit; the vault refuses an over-limit payout; restore", async () => {
    await page.goto("/app/operator");
    await settled(page);
    await caption(page, "Operator: lowers the per-payment limit to $5");
    await shot(page, "journey-06-operator");
    await page.getByLabel("New per-payment limit").fill("5");
    await page.getByTestId("change-limit").click();
    await expect(page.getByTestId("per-tx-cap")).toHaveText("$5", { timeout: 10 * 60_000 });
    await caption(page, "The vault contract refuses a $6 payout");
    await page.getByLabel("Test payout amount").fill("6");
    await page.getByTestId("vault-check").click();
    await expect(page.getByTestId("vault-check-result")).toContainText("Refused by the vault", { timeout: 2 * 60_000 });
    await expect(page.getByTestId("vault-check-result")).toContainText("OVER_PER_TX_CAP");
    await shot(page, "journey-07-vault-refuses");
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
      await shot(page, "journey-08-new-plan");
    }
  });

  await step("Operator: releases an identity hold", async () => {
    const button = page.getByTestId("demo-Release").first();
    if (await button.count()) {
      await caption(page, "Operator: releases a held milestone (simulated identity check)");
      await button.click();
      await expect(page.getByText(/Released to the provider's vault/).first()).toBeVisible({ timeout: 10 * 60_000 });
      await shot(page, "journey-09-identity-released");
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
      await shot(page, "journey-10-arbiter-vote");
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
      await shot(page, "journey-11-dispute-decided");
    }
  });

  await step("Handled failure: wrong network blocked, duplicate send refused", async () => {
    await page.goto("/app/send");
    await settled(page);
    await caption(page, "Send: the wallet is on the wrong network");
    await expect(page.getByRole("alert").filter({ hasText: "Wrong network" })).toBeVisible({ timeout: 2 * 60_000 });
    await shot(page, "journey-12-wrong-network");
    await page.getByRole("button", { name: "Switch to the wallet's network" }).click();
    await expect(page.getByRole("button", { name: /Confirm and send/ })).toBeEnabled({ timeout: 2 * 60_000 });
    await caption(page, "Send once, then try to send the same payment again");
    await page.getByRole("button", { name: /Confirm and send/ }).click();
    await expect(page.getByText(/Sent to the network/)).toBeVisible({ timeout: 5 * 60_000 });
    await page.getByRole("button", { name: /Send again/ }).click();
    await expect(page.getByText(/will not be sent twice|not be sent again/).first()).toBeVisible({ timeout: 2 * 60_000 });
    await shot(page, "journey-13-duplicate-refused");
  });
});

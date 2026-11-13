// The final film: two synchronised 1920x1080 recordings, Client (Kofi Mensah Ltd) and Freelancer (Amara Studio), one
// browser context each, both recording the whole time on one shared clock. Every step records its holds (played at
// normal speed) and its waits (sped up or cut) so e2e/cut-film.mjs can bring each step to its exact length.
//   npx playwright test --project=film-1920 --workers=1
// Writes e2e-artifacts/film-raw/{client,freelancer}.webm and e2e-artifacts/film/final-markers.json.
// Test network only; the card checkout and the payout rails are simulated and labelled so.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { startFilm } from "./film";
import { API } from "./helpers";

const TARGETS: Record<string, number> = { d1: 9.5, d2: 5.5, d3: 19, d4: 6.5, d5: 11, d6: 10, d7: 9, d8: 8, d9: 8.5, d10: 8.5 };
const CLIENT_EMAIL = "delivered@resend.dev"; // Resend's test inbox: the send really happens, no real person receives it
const RAW = "e2e-artifacts/film-raw";

test.setTimeout(90 * 60_000);

test("final film", async ({ browser }) => {
  mkdirSync(RAW, { recursive: true });
  // Warm up the balance reads (test-network RPC) before anything is recorded: each must answer within 20 seconds.
  for (const r of ["client", "payee_amara"]) {
    await expect(async () => {
      const res = await fetch(`${API}/wallets/${r}/balance`, { signal: AbortSignal.timeout(20_000) });
      expect(res.ok).toBe(true);
    }).toPass({ timeout: 5 * 60_000, intervals: [3_000] });
  }
  // Both sides start with their notifications read, so the bell lights up when the other side acts.
  for (const r of ["client", "freelancer"]) await fetch(`${API}/notifications/read-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: r }) });

  const open = async () => {
    const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } }, baseURL: "http://localhost:3000" });
    const page = await ctx.newPage();
    return { ctx, page, videoStart: Date.now() };
  };
  const K = await open(); // Client: Kofi Mensah Ltd
  const A = await open(); // Freelancer: Amara Studio
  const kf = await startFilm(K.page, "client");
  const af = await startFilm(A.page, "freelancer");
  const kp = K.page, ap = A.page;

  // A slow test-network RPC can hold a balance read for a while: allow a screen up to 4 minutes to finish loading.
  const ready = async (p: Page) => { await p.waitForLoadState("networkidle").catch(() => {}); await expect(p.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 4 * 60_000 }); };
  const go = async (p: Page, url: string) => { await p.goto(url, { waitUntil: "domcontentloaded" }); await ready(p); };
  await Promise.all([go(kp, "/app/dashboard?as=client"), go(ap, "/app/dashboard?as=freelancer")]);
  await Promise.all([kf.rendered(), af.rendered()]);

  // ---- shared timeline ----
  const T0 = Date.now();
  const sec = () => (Date.now() - T0) / 1000;
  type Step = { id: string; name: string; start: number; end: number; holds: [number, number][]; waits: [number, number][] };
  const steps: Step[] = [];
  let cur: Step | null = null;
  const capK = (t: string) => kf.caption(`Client · Kofi Mensah Ltd: ${t}`);
  const capA = (t: string) => af.caption(`Freelancer · Amara Studio: ${t}`);
  let lastK = "", lastA = "";
  const say = async (k?: string, a?: string) => { if (k) { lastK = k; await capK(k); } if (a) { lastA = a; await capA(a); } };
  const hold = async (ms = 2000) => { const s = sec(); await kp.waitForTimeout(ms); cur!.holds.push([s, sec()]); };
  const wait = async (fn: () => Promise<unknown>) => {
    await Promise.all([kf.caption("Waiting for confirmation, sped up", "wait"), af.caption("Waiting for confirmation, sped up", "wait")]);
    const s = sec();
    await fn();
    cur!.waits.push([s, sec()]);
    await Promise.all([lastK ? capK(lastK) : null, lastA ? capA(lastA) : null]);
  };
  const step = async (id: string, name: string, fn: () => Promise<void>) => {
    cur = { id, name, start: sec(), end: 0, holds: [], waits: [] };
    try { await fn(); } finally { cur.end = sec(); steps.push(cur); writeMarkers(); }
  };
  const writeMarkers = (extra: Record<string, unknown> = {}) => {
    mkdirSync("e2e-artifacts/film", { recursive: true });
    writeFileSync("e2e-artifacts/film/final-markers.json", JSON.stringify({
      viewport: "1920x1080", targets: TARGETS, steps,
      videos: { client: { offset: (T0 - K.videoStart) / 1000 }, freelancer: { offset: (T0 - A.videoStart) / 1000 } }, ...extra,
    }, null, 2));
  };
  const bellShows = async (p: Page) => expect(p.getByTestId("notif-count")).toBeVisible({ timeout: 3 * 60_000 });
  const openBell = async (f: typeof kf, p: Page, type: string) => {
    await f.click(p.getByTestId("notif-bell"));
    await ready(p);
    await expect(p.getByTestId(`notif-${type}`).first()).toBeVisible({ timeout: 60_000 });
  };
  const nudge = async (p: Page, l: Locator) => l.first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" })).then(() => p.waitForTimeout(600));

  let invoiceId = "", milestoneId = "";

  try {
    await step("d1", "Freelancer creates a contract; client idle", async () => {
      await say("Home", "Home");
      await hold(1500);
      await say(undefined, "creates a contract for Kofi Mensah Ltd");
      await af.click(ap.getByRole("link", { name: "Create contract" }).first());
      await ready(ap);
      await expect(ap.getByText("Step 1 of 4")).toBeVisible({ timeout: 60_000 });
      await af.type(ap.getByLabel("Client email"), CLIENT_EMAIL);
      await af.click(ap.getByRole("button", { name: "Continue" }));
      await expect(ap.getByText("Step 2 of 4")).toBeVisible({ timeout: 30_000 });
      const ms = [
        { title: "Brand identity", amount: "400", criteria: "Logo as SVG and PNG; brand colours with hex codes; one-page usage guide" },
        { title: "Landing page", amount: "600", criteria: "Page live on a test URL; mobile layout checked; copy approved" },
        { title: "Social media kit", amount: "300", criteria: "Ten post templates; profile and cover images for three platforms" },
      ];
      for (let i = 0; i < ms.length; i++) {
        if (i > 0) await af.click(ap.getByRole("button", { name: "Add milestone" }));
        await af.type(ap.getByLabel("Title").nth(i), ms[i]!.title);
        await af.type(ap.getByLabel("Amount in dollars").nth(i), ms[i]!.amount);
        await af.click(ap.getByLabel("Acceptance criteria").nth(i));
        await ap.getByLabel("Acceptance criteria").nth(i).fill(ms[i]!.criteria);
      }
      for (const next of [3, 4]) {
        await af.click(ap.getByRole("button", { name: "Continue" }));
        await expect(ap.getByText(`Step ${next} of 4`)).toBeVisible({ timeout: 30_000 });
      }
      await af.click(ap.getByRole("checkbox"));
      await hold(1000);
      await af.click(ap.getByTestId("demo-Sign and send"));
      await wait(() => ap.waitForURL(/\/app\/invoice\//, { timeout: 10 * 60_000 }));
      await ready(ap);
      invoiceId = ap.url().split("/app/invoice/")[1]!.split(/[?#]/)[0]!;
      milestoneId = (await (await fetch(`${API}/invoices/${invoiceId}`)).json()).escrow_milestone_id;
      await say(undefined, "contract signed; invoice 1 of 3 ($400)");
      await af.rendered();
      await hold(1500);
    });

    await step("d2", "Invoice email sent; Kofi's bell; Kofi opens the pay link", async () => {
      await say("an invoice arrives", "the invoice email is sent");
      await af.click(ap.getByRole("link", { name: /Notifications/ }).first());
      await ready(ap);
      await af.click(ap.getByTestId("emails-link"));
      await ready(ap);
      await expect(ap.getByTestId("email-list")).toContainText(/sent/i, { timeout: 2 * 60_000 });
      await af.rendered();
      await hold(1500);
      await wait(() => bellShows(kp));
      await openBell(kf, kp, "invoice_sent");
      await hold(1000);
      await say("opens the pay link");
      await kf.click(kp.getByTestId("notif-invoice_sent").first());
      await kp.waitForURL(/\/pay\//, { timeout: 60_000 });
      await ready(kp);
      await kf.rendered();
      await hold(1000);
    });

    await step("d3", "Kofi adds $400 by card (simulated), pays from the wallet; Connect wallet list; Amara's bell: funded", async () => {
      await go(ap, "/app/dashboard?as=freelancer");
      await say("adds $400 to the wallet by card (simulated checkout)", "Home");
      await kf.click(kp.getByRole("link", { name: "Wallet" }).first());
      await ready(kp);
      await expect(async () => {
        await kp.getByTestId("wallet-user-client").click({ timeout: 5_000 });
        await expect(kp.getByTestId("wallet-user-client")).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
      }).toPass({ timeout: 60_000 });
      await expect(kp.getByTestId("wallet-balance")).not.toHaveText("…", { timeout: 2 * 60_000 });
      const before = await kp.getByTestId("wallet-balance").textContent();
      await af.rendered();
      await kf.type(kp.getByLabel("Amount to add"), "400");
      await kf.click(kp.getByTestId("add-funds"));
      await wait(() => expect(kp.getByTestId("wallet-balance")).not.toHaveText(before ?? "", { timeout: 5 * 60_000 }));
      await expect(kp.getByTestId("wallet-activity")).toContainText("Added by card (simulated)", { timeout: 60_000 });
      await hold(1500);
      await say("pays milestone 1 from the wallet; the 5% fee comes out of the freelancer's payout");
      await go(kp, `/pay/${invoiceId}`);
      await kf.click(kp.locator("label", { hasText: "Tethran wallet" }));
      await expect(kp.getByTestId("payer-balance")).toBeVisible({ timeout: 2 * 60_000 });
      await nudge(kp, kp.getByTestId("platform-fee-note"));
      await expect(kp.getByTestId("platform-fee-note")).toContainText("Platform fee 5%");
      await hold(2000);
      await kf.click(kp.getByRole("button", { name: /Confirm and pay/ }));
      await wait(() => expect(kp.getByText("Funds locked.")).toBeVisible({ timeout: 10 * 60_000 }));
      await say("funded: the $400 is locked in escrow");
      await hold(1500);
      // About 3 seconds: the wallet list of the Connect wallet control (no wallet extension in this browser).
      await say("Connect wallet: the wallets a client can use");
      await kf.click(kp.getByTestId("connect-wallet"));
      const modal = kp.locator("w3m-modal, appkit-modal").first();
      await modal.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
      await hold(3000);
      await kp.keyboard.press("Escape");
      await kp.waitForTimeout(400);
      await wait(() => bellShows(ap));
      await say(undefined, "the bell: milestone 1 is funded");
      await openBell(af, ap, "milestone_funded");
      await hold(1500);
    });

    await step("d4", "Amara submits milestone 1; Kofi's bell: submission and the delivery check", async () => {
      await go(kp, "/app/dashboard?as=client");
      await go(ap, `/app/milestone/${milestoneId}?as=freelancer`);
      await say("Home", "submits milestone 1: a note, a link and the brand-kit notes");
      await af.type(ap.getByLabel("Delivery note"), "Brand identity delivered: logo files, colours and the usage guide.");
      await ap.getByLabel("Delivery link").fill("https://drive.example.com/kofi-brand-kit");
      await ap.getByLabel("Delivery files").setInputFiles({
        name: "brand-kit-notes.md", mimeType: "text/markdown",
        buffer: Buffer.from("# Kofi Mensah Ltd brand kit\n\n- Logo: logo.svg and logo.png, light and dark versions\n- Colours: Forest #0A1F1B, Lime #C6F24E, Sand #F4F1EA\n- Usage guide: one page with clear space, minimum sizes and colour pairs\n"),
      });
      await hold(800);
      await af.click(ap.getByTestId("submit-delivery"));
      await wait(() => expect(ap.getByTestId("delivery-check")).toBeVisible({ timeout: 5 * 60_000 }));
      await nudge(ap, ap.getByTestId("delivery-check"));
      await wait(() => bellShows(kp));
      await say("the bell: work submitted, with the AI's delivery check");
      await openBell(kf, kp, "work_submitted");
      await hold(1500);
    });

    await step("d5", "Kofi approves; the agent's activity and its proposal", async () => {
      await go(ap, "/app/dashboard?as=freelancer");
      await go(kp, `/app/milestone/${milestoneId}?as=client`);
      await say("approves the work", "Home");
      await nudge(kp, kp.getByTestId("delivery-check"));
      await kf.click(kp.getByRole("button", { name: /Approve work/ }));
      await wait(() => expect(kp.getByText("Work approved on-chain").first()).toBeVisible({ timeout: 10 * 60_000 }));
      await say("the platform releases the escrow; the AI reads the milestone and the delivery, then proposes");
      await kf.click(kp.getByTestId("demo-settle"));
      await wait(() => expect(kp.getByTestId("view-receipt")).toBeVisible({ timeout: 15 * 60_000 }));
      // A fresh load so the activity lines appear one by one at normal speed.
      await go(kp, `/app/milestone/${milestoneId}?as=client`);
      await nudge(kp, kp.getByTestId("agent-activity"));
      await expect(kp.getByTestId("agent-confidence")).toBeVisible({ timeout: 60_000 });
      await kp.waitForTimeout(2600); // the lines appear (about 3 s)
      await kf.show(kp.getByTestId("agent-proposal"));
      await hold(3500);
    });

    await step("d6", "Policy Service decision and the two signatures", async () => {
      await say("the Policy Service decides: every rule passed");
      await nudge(kp, kp.getByTestId("policy-signatures"));
      await hold(2000);
      await say("two signatures on each transfer: the agent signer and the Policy Service");
      await kf.show(kp.getByTestId("policy-signatures").getByText("Two signatures on every transfer"));
      await hold(2000);
    });

    await step("d7", "Amara's wallet shows the payout; Operator Earnings shows the fee", async () => {
      await say("Operator view: Tethran's earnings, the 5% fee", "the payout arrives in the wallet");
      await Promise.all([
        (async () => {
          await go(ap, "/app/wallet?as=freelancer");
          await expect(async () => {
            await ap.getByTestId("wallet-user-payee_amara").click({ timeout: 5_000 });
            await expect(ap.getByTestId("wallet-user-payee_amara")).toHaveAttribute("aria-selected", "true", { timeout: 2_000 });
          }).toPass({ timeout: 60_000 });
          await expect(ap.getByTestId("wallet-activity")).toBeVisible({ timeout: 2 * 60_000 });
          await nudge(ap, ap.getByTestId("wallet-activity"));
        })(),
        (async () => {
          await go(kp, "/app/earnings?as=operator");
          await expect(kp.getByTestId("earnings-lines")).toContainText(/\$\d/, { timeout: 2 * 60_000 });
        })(),
      ]);
      await Promise.all([af.rendered(), kf.rendered()]);
      await hold(3500);
    });

    await step("d8", "Operator lowers the cap to $5; the vault refuses $6; restore", async () => {
      await go(kp, "/app/operator?as=operator");
      await go(ap, "/app/dashboard?as=freelancer");
      await say("Operator: lowers the per-payment cap to $5", "Home");
      await af.rendered();
      await kf.type(kp.getByLabel("New per-payment limit"), "5");
      await kf.click(kp.getByTestId("change-limit"));
      await wait(() => expect(kp.getByTestId("per-tx-cap")).toHaveText("$5", { timeout: 10 * 60_000 }));
      await say("Operator: asks the vault for a $6 payout");
      await kf.type(kp.getByLabel("Test payout amount"), "6");
      await kf.click(kp.getByTestId("vault-check"));
      await wait(() => expect(kp.getByTestId("vault-check-result")).toContainText("Refused by the vault", { timeout: 2 * 60_000 }));
      await expect(kp.getByTestId("vault-check-result")).toContainText("OVER_PER_TX_CAP");
      await say("the vault contract refuses it: OVER_PER_TX_CAP");
      await nudge(kp, kp.getByTestId("vault-check-result"));
      await hold(2000);
      await say("Operator: restores the cap to $1,000");
      await kf.type(kp.getByLabel("New per-payment limit"), "1000");
      await kf.click(kp.getByTestId("change-limit"));
      await wait(() => expect(kp.getByTestId("per-tx-cap")).toHaveText("$1,000", { timeout: 10 * 60_000 }));
      await hold(800);
    });

    await step("d9", "The receipt, verified; both dashboards updating", async () => {
      await go(kp, `/receipt/${milestoneId}?as=client`);
      await say("the receipt: verify it against the test network", "Home: paid, with the receipt");
      await kf.click(kp.getByRole("button", { name: "Verify" }));
      await wait(() => expect(kp.getByText("Matches the record on the test network")).toBeVisible({ timeout: 2 * 60_000 }));
      await af.rendered();
      await hold(2500);
    });

    await step("d10", "Both dashboards, ending on the receipt", async () => {
      await go(kp, "/app/dashboard?as=client");
      await say("Home: milestone 1 paid", "Home: paid to you, after the 5% fee");
      await Promise.all([kf.rendered(), af.rendered()]);
      await hold(3000);
      await Promise.all([go(kp, `/receipt/${milestoneId}`), go(ap, `/receipt/${milestoneId}`)]);
      await say("the receipt", "the receipt");
      await Promise.all([kf.rendered(), af.rendered()]);
      await hold(3000);
    });
  } finally {
    writeMarkers({ invoiceId, milestoneId, finishedAt: new Date().toISOString() });
    const vk = kp.video(), va = ap.video();
    await K.ctx.close();
    await A.ctx.close();
    if (vk) renameSync(await vk.path(), `${RAW}/client.webm`);
    if (va) renameSync(await va.path(), `${RAW}/freelancer.webm`);
  }
});

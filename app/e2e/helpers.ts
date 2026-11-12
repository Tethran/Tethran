import { expect, type Page } from "@playwright/test";

export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:18788";

export async function api<T = any>(path: string): Promise<T> {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}

/** A full-page screenshot under e2e-artifacts/screens/<width>/<name>.png. */
export async function shot(page: Page, name: string) {
  const w = page.viewportSize()?.width ?? 0;
  // The recording caption belongs in the video, not over the content of a full-page screenshot.
  await page.screenshot({ style: "#e2e-caption { display: none !important; }", path: `e2e-artifacts/screens/${w}/${name}.png`, fullPage: true });
}

/** Visual check: nothing may scroll the page sideways. Returns the offending elements for the report. */
export async function overflow(page: Page) {
  return page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > W + 1) {
      // Anything inside its own scroll box or clipped by an overflow-hidden ancestor cannot widen the page.
      const clipped = (el: HTMLElement) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
        }
        return false;
      };
      for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
        const r = el.getBoundingClientRect();
        if (r.right > W + 1 && r.width > 0 && getComputedStyle(el).position !== "fixed" && !clipped(el)) {
          bad.push(`${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ").slice(0, 3).join(".") : ""} right=${Math.round(r.right)} > ${W}`);
        }
        if (bad.length >= 6) break;
      }
      if (bad.length === 0) bad.push(`scrollWidth ${document.documentElement.scrollWidth} > ${W}`);
    }
    return bad;
  });
}

/** Waits until the API-driven page has finished its first load (no skeleton blocks left). */
export async function settled(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 90_000 });
}

/** A caption at the bottom left of the recording (hidden in full-page screenshots). */
export async function caption(page: Page, text: string) {
  await page.evaluate((t) => {
    document.getElementById("e2e-caption")?.remove();
    const d = document.createElement("div");
    d.id = "e2e-caption";
    d.textContent = t;
    Object.assign(d.style, { position: "fixed", left: "16px", bottom: "16px", zIndex: "9999", background: "#0A1F1B", color: "#C6F24E", padding: "10px 16px", borderRadius: "999px", font: "600 16px system-ui", pointerEvents: "none", maxWidth: "calc(100vw - 32px)" });
    document.body.appendChild(d);
  }, text);
}

/** Freelancer: the contract wizard with its defaults, signed with the provider's demo key. Returns the new ids. */
export async function createContract(page: Page, beforeSign?: () => Promise<void>) {
  await page.goto("/app/contracts/new");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  if (beforeSign) await beforeSign();
  await page.getByTestId("demo-Sign and send").click();
  await page.waitForURL(/\/app\/invoice\//, { timeout: 5 * 60_000 });
  const invoiceId = page.url().split("/app/invoice/")[1]!.split(/[?#]/)[0]!;
  const inv = await api(`/invoices/${invoiceId}`);
  return { invoiceId, milestoneId: inv.escrow_milestone_id as string };
}

/** Client: pays the invoice with the chosen method; resolves when the escrow is funded on-chain. */
export async function pay(page: Page, invoiceId: string, method: "Card" | "Stablecoin", wait: (fn: () => Promise<void>) => Promise<void> = (fn) => fn()) {
  await page.goto(`/pay/${invoiceId}`);
  await settled(page);
  if (method !== "Card") await page.locator("label", { hasText: method }).click();
  await page.getByRole("button", { name: /Confirm and pay/ }).click();
  await wait(() => expect(page.getByText("Funds locked.")).toBeVisible({ timeout: 10 * 60_000 }));
}

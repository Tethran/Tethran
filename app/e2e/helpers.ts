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

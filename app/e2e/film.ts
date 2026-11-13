// Recording tooling for the final demo video (1920x1080). Use these instead of raw Playwright actions in a film spec:
//
//   const film = await startFilm(page, "demo");      // overlay cursor + caption + step markers
//   await film.step("1. Freelancer creates a contract", async () => { ... });
//   await film.click(locator); await film.type(locator, "text"); await film.show(locator); await film.hold(2000);
//   await film.wait("Waiting for confirmation", () => expect(x).toBeVisible({ timeout })); // sped up in the cut
//   await film.finish();                               // writes e2e-artifacts/film/<name>-markers.json
//
// Rules it enforces: a visible cursor that glides (eased, intermediate steps) to each element before a click, with a
// click ripple; typing at human speed; every key screen fully rendered (no spinner, images loaded, layout settled)
// before it is held; smooth scrolling to bring content into view; no full-page captures (fixed 1080-high viewport).
// Waits for confirmations are recorded as "wait" spans; e2e/cut-video.mjs speeds them up and the caption reads
// "Waiting for confirmation, sped up".
import { mkdirSync, writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

async function installOverlay(page: Page) {
  await page.addInitScript(() => {
    const css = `
      #film-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:none}
      #film-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
      .film-ripple{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:999px;border:2px solid #C6F24E;background:rgba(198,242,78,.25);z-index:2147483646;pointer-events:none;animation:film-r .55s ease-out forwards}
      @keyframes film-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
      #film-caption{position:fixed;left:24px;bottom:24px;z-index:2147483645;background:#0A1F1B;color:#C6F24E;padding:10px 18px;border-radius:999px;font:600 18px system-ui;pointer-events:none;max-width:calc(100vw - 48px)}
      #film-caption.wait{background:#1f2937;color:#e5e7eb}`;
    const mount = () => {
      if (document.getElementById("film-cursor")) return;
      const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
      const c = document.createElement("div"); c.id = "film-cursor";
      c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#0A1F1B" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      const pos = (window as any).__filmPos ?? { x: 960, y: 540 };
      c.style.left = pos.x + "px"; c.style.top = pos.y + "px";
      document.body.appendChild(c);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  });
}

export async function startFilm(page: Page, name: string) {
  await installOverlay(page);
  const t0 = Date.now();
  const steps: { name: string; start: number; end: number; key?: boolean }[] = [];
  const waits: [number, number][] = [];
  let pos = { x: 960, y: 540 };
  const sec = () => (Date.now() - t0) / 1000;

  async function moveTo(x: number, y: number) {
    const from = { ...pos };
    const dist = Math.hypot(x - from.x, y - from.y);
    const n = Math.max(12, Math.min(40, Math.round(dist / 25)));
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      const p = { x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k };
      await page.evaluate(({ x, y }) => { (window as any).__filmPos = { x, y }; const c = document.getElementById("film-cursor"); if (c) { c.style.left = x + "px"; c.style.top = y + "px"; } }, p);
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(14);
    }
    pos = { x, y };
  }

  /** Waits until the screen is fully rendered: no busy skeletons or spinners, images loaded, layout stable. */
  async function rendered() {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => {
      if (document.querySelector('[aria-busy="true"], .animate-spin')) return false;
      return Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0);
    }, null, { timeout: 120_000 }).catch(() => {});
    let last = -1;
    for (let i = 0; i < 20; i++) { // layout settled: the page height stops changing
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      if (h === last) break;
      last = h;
      await page.waitForTimeout(150);
    }
  }

  async function caption(text: string, kind: "step" | "wait" = "step") {
    await page.evaluate(({ text, kind }) => {
      let d = document.getElementById("film-caption");
      if (!d) { d = document.createElement("div"); d.id = "film-caption"; document.body.appendChild(d); }
      d.className = kind === "wait" ? "wait" : ""; d.textContent = text;
    }, { text, kind });
  }

  /** Smoothly scrolls an element into the middle of the viewport. */
  async function show(l: Locator) {
    await l.first().waitFor({ state: "visible", timeout: 120_000 });
    await l.first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    await page.waitForTimeout(700);
  }

  return {
    rendered,
    show,
    caption,
    hold: (ms = 2000) => page.waitForTimeout(ms),
    /** Glides the cursor to the element, then clicks it with a ripple. */
    async click(l: Locator) {
      await show(l);
      const b = await l.first().boundingBox();
      if (!b) throw new Error("element has no box");
      await moveTo(b.x + b.width / 2, b.y + b.height / 2);
      await page.evaluate(({ x, y }) => { const r = document.createElement("div"); r.className = "film-ripple"; r.style.left = x + "px"; r.style.top = y + "px"; document.body.appendChild(r); setTimeout(() => r.remove(), 600); }, pos);
      await l.first().click();
      await page.waitForTimeout(250);
    },
    /** Clicks into the field and types at human speed. */
    async type(l: Locator, text: string) {
      await this.click(l);
      await l.first().fill("");
      await l.first().pressSequentially(text, { delay: 55 });
    },
    /** A wait for the chain or a service: recorded so the cut speeds it up; captioned as such. */
    async wait(label: string, fn: () => Promise<unknown>) {
      await caption(`${label}, sped up`, "wait");
      const s = sec();
      await fn();
      waits.push([s, sec()]);
    },
    /** A named step with start and end seconds in the markers file; key steps get a 1.5 s hold at the end. */
    async step(stepName: string, fn: () => Promise<void>, opts: { key?: boolean } = {}) {
      const start = sec();
      await caption(stepName);
      await fn();
      await rendered();
      if (opts.key) await page.waitForTimeout(1500);
      steps.push({ name: stepName, start, end: sec(), ...(opts.key ? { key: true } : {}) });
    },
    finish() {
      mkdirSync("e2e-artifacts/film", { recursive: true });
      writeFileSync(`e2e-artifacts/film/${name}-markers.json`, JSON.stringify({ name, viewport: "1920x1080", steps, waits }, null, 2));
      return { steps, waits };
    },
  };
}

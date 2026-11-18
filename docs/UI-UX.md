# Tethran UI/UX handoff

A design handoff another project can copy to reuse Tethran's look and feel. Every value below is taken from the code
(paths given). Anything the code does not define is marked **NOT FOUND**. Hex values are converted from the OKLCH
values in the code (OKLab to sRGB, clipped to the sRGB range); the OKLCH value is the source of truth.

Stack: Tailwind CSS v4 (CSS-first configuration, no `tailwind.config.*` file), shadcn/ui ("new-york" style, Lucide
icons), React 19, TanStack Start.

---

## 1. Palette

All colour is defined in **`app/src/styles.css`**: raw tokens and light values on `:root`, dark overrides on `.dark`,
and the Tailwind colour names mapped in `@theme inline` (`--color-<name>: var(--<name>)`, so `bg-ink`, `text-lime`,
`border-line` and so on).

### Light (`:root`)

| Role | CSS variable | Tailwind name | OKLCH (source) | Hex |
|---|---|---|---|---|
| Background | `--background` | `bg-background` | `oklch(0.968 0.005 117.9)` | `#F4F5F1` |
| Surface / card | `--surface` (= `--card`, `--popover`) | `bg-surface`, `bg-card` | `oklch(0.995 0.002 120)` | `#FDFEFC` |
| Border | `--line` (= `--border`, `--input`) | `border-line`, `border` | `oklch(0.907 0.01 140.5)` | `#DDE2DC` |
| Muted (fill) | `--muted` (= `--secondary`) | `bg-muted` | `oklch(0.935 0.008 130)` | `#E8EBE5` |
| Text | `--ink` (= `--foreground`) | `text-ink`, `text-foreground` | `oklch(0.22 0.028 179.5)` | `#0A1F1B` |
| Text, muted | `--muted-foreground` | `text-muted-foreground` | `oklch(0.513 0.021 170.8)` | `#5B6B65` |
| Brand / primary | `--primary` = `--ink` | `bg-primary`, `bg-ink` | as Text | `#0A1F1B` |
| Primary hover | `--forest` (`hover:bg-forest` on ink buttons) | `bg-forest` | `oklch(0.372 0.058 169.2)` | `#1B4A3B` |
| Primary foreground | `--on-dark` (= `--primary-foreground`) | `text-on-dark` | `oklch(0.959 0.007 151.9)` | `#EEF3EF` |
| Accent (lime) | `--accent` | `bg-lime`, `bg-accent` | `oklch(0.883 0.148 126.5)` | `#BFEA7A` |
| Accent foreground | `--accent-ink` | `text-lime-ink` | `oklch(0.263 0.058 129.9)` | `#1B2A08` |
| Accent hover | NOT FOUND as a token (`hover:brightness-95` on lime buttons) | | | |
| Second dark surface | `--ink-2` | `bg-ink-2` | `oklch(0.267 0.033 176.1)` | `#122B25` |
| Muted text on dark | `--muted-dark` | `text-muted-dark` | `oklch(0.759 0.02 162.8)` | `#A6B5AD` |
| Border on dark | `--line-dark` | `border-line-dark` | `oklch(0.959 0.007 151.9 / 14%)` | `#2A3D39` (14% over ink) |
| Focus ring | `--ring` = `--forest`; `:focus-visible` uses `--accent` | | | see section 6 |
| Success | `--success` | `text-success`, `bg-success/12` | `oklch(0.618 0.151 154.7)` | `#0D9F5B` |
| Warning | `--progress` | `text-progress`, `bg-progress/15` | `oklch(0.762 0.146 79)` | `#E3A52C` |
| Danger | `--danger` (= `--destructive`) | `text-danger`, `bg-danger` | `oklch(0.626 0.193 23)` | `#E5484D` |
| Info | NOT FOUND. The closest is `--agent` (the AI's colour, also "In review") | `text-agent`, `bg-agent/10` | `oklch(0.662 0.179 264.6)` | `#5B8CFF` |

Other tokens on `:root`: `--radius: 0.875rem`; `--shadow-soft`, `--shadow-float` (section 3); `--glass:
oklch(0.995 0.002 120 / 70%)`; `--glass-dark: oklch(0.267 0.033 176.1 / 60%)`. Charts: `--color-chart-1: var(--forest)`,
`--color-chart-2: var(--accent)`. `theme-color` meta: `#0A1F1B` (`app/src/routes/__root.tsx`).

### Dark (`.dark`)

| Role | Value in `.dark` | Hex |
|---|---|---|
| Background | `--ink` | `#0A1F1B` |
| Surface / card | `--ink-2` | `#122B25` |
| Border | `--line-dark` | `#2A3D39` (14% `on-dark` over ink) |
| Muted (fill) | `--ink-2` | `#122B25` |
| Text | `--on-dark` | `#EEF3EF` |
| Text, muted | `--muted-dark` | `#A6B5AD` |
| Brand / primary | `--accent` (lime) | `#BFEA7A` |
| Primary foreground | `--accent-ink` | `#1B2A08` |
| Secondary | `--forest` | `#1B4A3B` |
| Accent, success, warning, danger, info | not overridden (same as light) | as light |

### Do the dashboard and the marketing site share the palette?

Yes: one palette, one stylesheet. There is **no theme switch** (no theme provider, no toggle). The `.dark` class is
applied in one place only: the landing page's closing section (`app/src/components/landing/Closing.tsx`). Elsewhere,
dark areas are built with the dark tokens directly (`bg-ink text-on-dark`), for example the dashboard's balance card,
the mobile bottom nav and the `Ticket` stub.

---

## 2. Typography

Defined in `app/src/styles.css` (`@theme inline` and `@layer base`); fonts loaded from Google Fonts in
`app/src/routes/__root.tsx`:

```
https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,600&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap
```

| Role | Family (token) | Weights loaded |
|---|---|---|
| Display and headings | Bricolage Grotesque (`--font-display`, `font-display`) | 300, 600 (optical size 12 to 96) |
| Body and UI | IBM Plex Sans (`--font-sans`, default on `body`) | 400, 500, 600 |
| Mono | JetBrains Mono (`--font-mono`, `font-mono`) | 400, 500 |

- **Inter:** not used (NOT FOUND). **JetBrains Mono:** used.
- Weights in use: 300 (`weight-light`, the light first words of headings such as "Review **and send.**"), 400 body,
  500 (`font-medium`: buttons, labels, list titles), 600 (headings, amounts, `font-semibold`).

### Type scale

| Element | Size | Line height | Other | Where |
|---|---|---|---|---|
| Hero display | `clamp(3.1rem, 8vw, 6rem)` | 0.98 | 600, `-0.045em` | `display-hero` utility |
| Section display | `clamp(2.25rem, 5.4vw, 4.25rem)` | 1 | 600, `-0.04em` | `display-section` |
| Giant display | `clamp(3.4rem, 11vw, 10rem)` | 0.92 | 600, `-0.05em` | `display-giant` |
| h1 (app pages) | `text-4xl` / `md:text-5xl` (Tailwind: 2.25rem / 3rem) | 1 (base rule) | display 600, `-0.04em` | `PageHead` in `app/src/components/app/AppShell.tsx` |
| h2 | `text-xl` in cards, `text-2xl` for dashboard sections (1.25rem / 1.5rem) | 1 | display 600 | e.g. `app.milestone.$id.tsx`, `app.dashboard.tsx` |
| h3, h4 | no fixed size (same family, weight, tracking, line height 1) | 1 | | base rule |
| h5, h6 | NOT FOUND (no style, not used) | | | |
| Body | 1.0625rem (17px) | 1.6 | IBM Plex Sans 400 | `body` in `styles.css` |
| Small | `text-sm` (0.875rem) and `text-xs` (0.75rem), Tailwind defaults | Tailwind defaults | | throughout |
| Mono | `text-xs` / `text-[0.68rem]` | Tailwind defaults | uppercase + `tracking-[0.18em]` for eyebrows | |
| Amounts (hero numbers) | `text-3xl` / `text-5xl` / `text-6xl md:text-7xl` | | display 600, `-0.04em`, `tabular-nums` | `Amount` in `app/src/components/tethran/ui.tsx` |

### Where the mono font is used

Eyebrows (page and section labels, `Eyebrow`, `PageHead`), wallet addresses, transaction hashes, trace ids, reason
codes (`ReasonList`), the "Simulated" / "Test network" tags (`SimTag`), the bell's unread count, the `Details` rows,
amounts in tables and in the send review (`font-mono` cells in `app.earnings.tsx`, `app.reconciliation.tsx`,
`app.send.tsx`), and the Live model / Replay tag. Large hero amounts use the display font with `tabular-nums`, not mono.

---

## 3. Layout and density

| Item | Value | Where |
|---|---|---|
| Spacing scale | Tailwind v4 default (0.25rem steps); no custom spacing tokens | `styles.css` defines none |
| Max content width | `max-w-[1200px]` (app shell, landing sections); centred narrow pages `max-w-3xl`, `max-w-lg`, `max-w-md`; some landing sections `max-w-[1100px]` | `AppShell.tsx`, landing components |
| Page gutter | `px-4` (app), `px-5` (landing) | |
| Radius | `--radius` 0.875rem (14px); `radius-sm` 10px, `md` 12px, `lg` 14px, `xl` 18px, `2xl` 22px; `--radius-card` 20px; `--radius-input` 14px; `--radius-sheet` 32px; buttons, chips and nav are `rounded-full` | `styles.css` |
| Shadows | `--shadow-soft: 0 1px 2px oklch(0.22 0.028 179.5 / 5%), 0 12px 32px -12px oklch(0.22 0.028 179.5 / 14%)`; `--shadow-float: 0 24px 60px -24px oklch(0.22 0.028 179.5 / 30%)` | `styles.css` (`shadow-soft`, `shadow-float`) |
| Borders | 1px `--line` everywhere (`* { border-color: var(--color-border) }`); dashed borders for empty states and the simulated/test tag | `styles.css`, `demo-state.tsx`, `ui.tsx` |
| Glass | `glass` (70% surface, `blur(16px) saturate(1.4)`), `glass-dark` | landing nav, hero chips |
| Grid | CSS grid with `min-width: 0` on all grid children (no sideways scroll on phones); e.g. milestone page `lg:grid-cols-[1.4fr_1fr]`, landing hero `lg:grid-cols-[1.1fr_1fr]` | `styles.css`, routes |

### Dashboard density

- Header: sticky, `h-16`, `bg-background/85 backdrop-blur`, bottom border.
- Touch targets: buttons, nav items and inputs are at least 44px (`min-h-11`); the mobile bottom nav items `min-h-12`.
- Cards: `p-5 md:p-6`, radius 20px, `shadow-soft` (`Card` in `ui.tsx`).
- Tables: cell padding `p-4` (16px), header cells `font-medium`, amount cells right-aligned mono
  (`app.earnings.tsx`, `app.reconciliation.tsx`). Row height: NOT FOUND as a fixed value (it follows the padding).
- Page rhythm: `main` `py-6 md:py-10`; `PageHead` `mb-8`.
- Mobile: a floating bottom nav (`fixed inset-x-3 bottom-3`, `bg-ink`, `rounded-3xl`, `shadow-float`) that scrolls
  sideways (`overflow-x-auto`, `touch-pan-x`), with items at least `4.25rem` wide; the page gets `pb-28` so content
  clears it.

### Landing page versus dashboard

The landing page uses the same tokens with more air and motion: `section-pad` (`padding-block: clamp(4.5rem, 10vw,
10rem)`, `padding-inline: 1.25rem`), the display type utilities, a glass pill nav fixed at the top (`max-w-3xl`),
floating 3D objects and chips, and one dark closing section with radius 32px at the top.

---

## 4. Components

| Pattern | What it looks like | File |
|---|---|---|
| Buttons | Pill buttons (`pill` variants via `cva`): `ink` (dark, hover forest), `lime`, `ghost` (bordered surface, hover ink border), `ghostDark`, `danger`; sizes `md`, `lg`, `plain`; an arrow chip that rotates 45 degrees on hover. `PillButton`, `PillLink` | `app/src/components/tethran/ui.tsx` |
| Buttons (shadcn) | Available but the custom pills are used in the product | `app/src/components/ui/button.tsx` |
| Inputs | `h-11` / `min-h-11`, `rounded-[var(--radius-input)]` or `rounded-full` (selects), 1px border, `bg-background` | e.g. `app.contracts.new.tsx`, `app.send.tsx`, `app.milestone.$id.tsx` |
| Cards | `Card` (surface, border, radius 20px, `shadow-soft`; `dark` variant on ink); `Ticket` (light main part, notch, dark stub, `shadow-float`) | `ui.tsx` |
| Tables | Plain `<table>` with `p-4` cells, mono right-aligned amounts | `app/src/routes/app.earnings.tsx`, `app/src/routes/app.reconciliation.tsx` |
| Status pills | `StatusChip` per milestone status (Draft, Funded, In review, Approved, Released, Disputed, Paid out, Refunded), each with an icon and a tinted fill; `DecisionChip` (Approved, Rejected, Escalated to a human) | `ui.tsx` |
| Tags | `SimTag`: dashed, mono, uppercase, with a warning-coloured dot ("Simulated", "Test network"); the "Live model" / "Replay" tag | `ui.tsx`; `ModeTag` in `app.milestone.$id.tsx` |
| Milestone stepper | Vertical timeline: 32px circles (`size-8`, `border-2`), done = ink fill with a lime check; steps Funded, Delivered, Approved, Released to the vault, Paid out, Receipt | `app/src/routes/app.milestone.$id.tsx` (`TL`) |
| Wallet review panel | Sheet card (radius 32px): recipient by name with address in mono, amount, separate network fee, network select, wrong-network alert, collapsible `Details`, live status area (`aria-live`) | `app/src/routes/app.send.tsx`; pay-from-wallet variant in `app/src/components/app/ExternalPay.tsx` |
| Notification bell | 44px round bordered link; unread count as a lime mono badge (`99+` cap); refreshes every 2 s | `app/src/components/app/Bell.tsx` |
| Empty state | Dashed card, a 3D object illustration, an inbox icon and a title | `EmptyBlock` in `app/src/components/app/demo-state.tsx` |
| Loading state | Skeleton blocks `h-20`, radius 20px, `aria-busy="true"` | `LoadingBlock` in `demo-state.tsx` |
| Error state | Dashed card, danger icon, "We couldn't reach the server.", Try again | `ErrorBlock` in `demo-state.tsx` |
| Toasts | sonner, `position="top-center"`, background/foreground/border tokens | `app/src/components/ui/sonner.tsx`, `app/src/routes/__root.tsx` |
| Reason codes | Each Policy reason as a muted rounded row: bold title, plain sentence, mono code | `ReasonList` in `ui.tsx` |
| AI activity | Agent-coloured card; lines revealed one by one; proposal box with confidence | `app/src/components/app/AgentActivity.tsx` |
| App shell | Logo + "Test network" tag, icon nav (labels at `xl`), Connect wallet, bell, role button | `app/src/components/app/AppShell.tsx` |
| Logo | Ink circle with a lime dot, "Tethran" in the display font | `Logo` in `ui.tsx` |
| Test-key label | `DEMO_LABEL = "Signed with a test key"` on every test-key action and its result. The label "Demo: signed with a test key" is NOT FOUND in the code (it was renamed) | `app/src/api/wallet.ts`, `app/src/components/app/SignChoice.tsx` |

---

## 5. Motion

| What | Duration and easing | Where |
|---|---|---|
| Page transitions | NOT FOUND (no route transition animation) | |
| Live refresh (2 s) | Data polling only (`refetchInterval: 2000`); no animation on refresh | `LIVE` in `demo-state.tsx`, `Bell.tsx` |
| Buttons | `transition-all duration-200`; arrow chip `group-hover:rotate-45` (200 ms) | `ui.tsx` |
| Hover | Colour changes (`hover:bg-forest`, `hover:border-ink`, `hover:text-ink`, `hover:brightness-95`) | throughout |
| Focus | `:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px }` | `styles.css` |
| Scroll reveal | `Reveal`: `transition-all duration-700 ease-out`, from `translate-y-6 opacity-0` | `app/src/components/tethran/Reveal.tsx` |
| Headline word reveal | `animate-word`: 0.6s `cubic-bezier(.2,.7,.2,1)`, opacity + 0.4em rise + 6px blur; delay 120 ms + 180 ms per word | `Reveal.tsx`, `styles.css` |
| Ambient | `animate-float` 6s ease-in-out infinite; `animate-drift` 9s; `animate-marquee` 40s linear; `animate-flow` 1s linear | `styles.css`, landing |
| Signals | `animate-lime-pulse` 1.6s ease-out; `animate-red-pulse` 1.2s ease-out | `styles.css` |
| Moments | `animate-stamp` 0.45s ease-out (dispute decided, `app.arbiter.tsx`); `animate-seal` 0.7s `cubic-bezier(.2,.7,.2,1)` (`pay.$id.tsx`, `receipt.$id.tsx`) | `styles.css` |
| AI activity lines | One line every 650 ms, 300 ms opacity transition | `AgentActivity.tsx` |
| Library | `tw-animate-css` imported | `styles.css` |

**prefers-reduced-motion: respected.** `styles.css` sets animation and transition durations to 0.01ms, one iteration,
and `scroll-behavior: auto` for every element when the user asks for reduced motion.

---

## 6. Accessibility

Contrast ratios (WCAG 2.x), computed from the hex values above.

| Pair | Ratio | Result |
|---|---|---|
| Text `#0A1F1B` on background `#F4F5F1` | 15.66:1 | AA |
| Text on surface `#FDFEFC` | 16.93:1 | AA |
| Muted text `#5B6B65` on background | 5.12:1 | AA |
| Muted text on surface | 5.53:1 | AA |
| Primary: on-dark `#EEF3EF` on ink `#0A1F1B` | 15.27:1 | AA |
| Primary hover: on-dark on forest `#1B4A3B` | 8.94:1 | AA |
| Accent: lime-ink `#1B2A08` on lime `#BFEA7A` | 11.06:1 | AA |
| Dark: on-dark on ink (background) | 15.27:1 | AA |
| Dark: on-dark on ink-2 (surface) | 13.36:1 | AA |
| Dark: muted-dark `#A6B5AD` on ink | 8.04:1 | AA |
| Dark: muted-dark on ink-2 | 7.03:1 | AA |
| Dark: lime (primary) on ink | 12.50:1 | AA |

### Pairs that fail WCAG AA (4.5:1 for normal text)

| Pair | Ratio | Used as text in |
|---|---|---|
| Danger `#E5484D` on surface | 3.85:1 (large text only) | errors, e.g. `pay.$id.tsx`, `app.contracts.new.tsx`, `demo-state.tsx` |
| Danger on background | 3.56:1 (large text only) | same |
| On-dark on danger (danger pill button) | 3.48:1 (large text only) | `pill` `danger` variant in `ui.tsx` |
| Success `#0D9F5B` on surface | 3.38:1 (large text only) | "met" tags and checks, e.g. `AgentActivity.tsx`, `app.milestone.$id.tsx` |
| Agent `#5B8CFF` on surface | 3.12:1 (large text only) | "AI activity", "The AI's plan" labels |
| Warning `#E3A52C` on surface | 2.14:1 (fails) | `text-progress` icons and text, e.g. `app.send.tsx`, `app.reconciliation.tsx` |
| Focus outline: lime `#BFEA7A` on background | 1.25:1 (fails the 3:1 non-text minimum) | `:focus-visible` on light backgrounds |

Other: the app sets `aria-busy` on loading blocks, `role="alert"` on errors, `aria-live="polite"` on the send status,
labels on icon-only nav links and the bell, and keeps grid children shrinkable so phones never scroll sideways.

---

## 7. Brand feel

PROPOSED, confirm with Benedict. Derived from the copy ("Get paid for the work you deliver.", "Rules the AI can't
break.") and the visuals (deep green ink, one lime accent, rounded pills, 3D objects, a night globe of Africa).

| Fits (PROPOSED, confirm with Benedict) | Does not fit (PROPOSED, confirm with Benedict) |
|---|---|
| Calm | Hype |
| Trustworthy | Flashy |
| Plain-spoken | Jargon-heavy |
| Precise | Vague |
| Warm | Cold or corporate |
| Grounded | Neon or "crypto" styling |
| Confident | Cartoonish |
| Pan-African | Generic global fintech |

---

## 8. Voice

Microcopy taken from the app:

1. "Get paid for the work you deliver." (landing hero, `Hero.tsx`)
2. "Contracts that pay themselves, in dollars, to your phone." (landing hero)
3. "Rules the AI can't break." (operator page title, `app.operator.tsx`)
4. "We couldn't reach the server." / "Your last known status is safe. Check your connection." (error state,
   `demo-state.tsx`)
5. "No milestones yet. Create a contract to start." (empty state, `app.dashboard.tsx`)
6. "Receipts appear after a payout." (empty state, `app.dashboard.tsx`)
7. "Still on its way. Checked the same payment again; it was not resent." (send recheck, `app.send.tsx`)
8. "Evidence is data for the AI, never instructions. Files are stored for download only, never opened or run."
   (delivery form, `app.milestone.$id.tsx`)
9. "Advisory: checked against the milestone's acceptance criteria. You decide whether to approve." (delivery check)
10. "The agent only proposes. It holds no key that can pay; the Policy Service decides." (`AgentActivity.tsx`)

The pattern: short sentences, what happened first, then what it means for the person; the safety facts are stated
plainly.

---

## 9. Reuse kit

### Files to copy

| File | What it brings |
|---|---|
| `app/src/styles.css` | All tokens (colours, fonts, radii, shadows), the base rules, the utilities (`display-*`, `glass`, `shadow-*`, `section-pad`, `ticket-notch`), the keyframes and the reduced-motion rule |
| `app/components.json` | shadcn configuration (new-york, CSS variables, Lucide, aliases) |
| `app/src/lib/utils.ts` | `cn()` (clsx + tailwind-merge) |
| `app/src/components/tethran/ui.tsx` | Pill buttons and links, `StatusChip`, `DecisionChip`, `SimTag`, `Amount`, `Details`, `Ticket`, `Card`, `Eyebrow`, `Logo`, `ReasonList` |
| `app/src/components/tethran/Reveal.tsx` | `Reveal`, `WordReveal`, `useInView` |
| `app/src/components/app/demo-state.tsx` | `LoadingBlock`, `ErrorBlock`, `EmptyBlock`, `Async` |
| `app/src/components/app/AppShell.tsx` | The app shell (header, nav, mobile bottom nav) and `PageHead` |
| `app/src/components/ui/sonner.tsx`, `app/src/components/ui/skeleton.tsx` | Toasts and the skeleton |
| Font import | The Google Fonts URL from `app/src/routes/__root.tsx` (section 2) |
| Tailwind config file | NOT FOUND (Tailwind v4 is configured in `styles.css`) |
| Theme provider | NOT FOUND (light only; dark tokens through the `.dark` class) |

### Steps

1. Install: `tailwindcss@^4.2.1` and `@tailwindcss/vite@^4.2.1`, `tw-animate-css@^1.3.4`,
   `class-variance-authority@^0.7.1`, `clsx@^2.1.1`, `tailwind-merge@^3.5.0`, `lucide-react@^0.575.0`,
   `sonner@^2.0.7`; for `demo-state.tsx`, `@tanstack/react-query@^5.101.1`.
2. Add the Tailwind Vite plugin and import `styles.css` once at the root. Its first lines are
   `@import "tailwindcss" source(none); @source "../src";`: change `@source` to your source folder.
3. Add the font links (two `preconnect` links and the stylesheet URL from section 2) to the document head.
4. Copy `utils.ts` to `src/lib/` and `components.json` to the project root (keep the `@/` alias).
5. Copy the component files. In `ui.tsx`, `StatusChip` and `ReasonList` import Tethran's types and reason texts
   (`@/api/types`, `@/api/reasons`): replace them with your own or delete those two components. `EmptyBlock` uses
   `Object3D` and the images in `app/public/objects/`: copy those or replace the illustration.
6. Mount `<Toaster position="top-center" />` once at the root.
7. For a dark area, wrap it in `class="dark"` or use `bg-ink text-on-dark` directly.

---

## 10. Open items for the team

| Item | Value |
|---|---|
| Reference sites, landing (3 to 5) | |
| Reference sites, docs (3 to 5) | |
| Reference sites, dashboard density (3 to 5) | |
| Reference site for motion (1) | |
| A site we dislike (1) | |
| Exact domain spelling | |
| Legal entity | |
| Security contact email | |

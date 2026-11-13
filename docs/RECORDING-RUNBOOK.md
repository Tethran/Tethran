# Recording runbook: the demo, steps d1 to d10 (manual screen recording)

Derived from `app/e2e/film.spec.ts`. Test network only (Sepolia); every amount is test USDT; card checkout and the
payout rails are simulated and labelled so. Nothing here moves real money.

## Before you start

1. **Fresh state** (only if the data is not fresh; about 40 minutes on Sepolia):
   `cd services/backend` then `DEMO_MODE=1 CHAIN=sepolia npx tsx scripts/seed.ts`
   (PowerShell: `$env:DEMO_MODE="1"; $env:CHAIN="sepolia"; npx tsx scripts/seed.ts`). It ends with
   `12 scenarios seeded; 0 problems`.
2. **Start everything** (one command, keeps running, Ctrl+C stops all):
   `cd services/backend` then `npm run record`
   It starts the Policy Service, the backend (with the Settlement Agent, live model with a labelled replay fallback),
   the demo signer and the web app, waits until each answers its health check, and prints the URLs. Wait for
   `Demo services running on the seeded state`. The first start after a reboot can take up to 4 minutes (the web app
   compiles).
3. **Two browser windows, two browser profiles.** The role ("logged in as") is kept per browser profile and syncs
   across tabs of the same profile, so Kofi and Amara must be in different profiles: for example a normal window for
   Kofi and a private/incognito window for Amara. Size each to 1920x1080 (or 960x1080 side by side).
4. **Clear the bells** so they light up only with the recorded actions: in each window open
   `http://localhost:3000/app/notifications` and click **Mark all read**.

### Logins

There are no passwords. The app shows the view of one person, chosen with `?as=` in any app URL (it is remembered in
that browser profile) or with the role button at the top right (it opens `/app`, the role chooser):

| Person | Role | Set with |
|---|---|---|
| Kofi Mensah Ltd (the client) | client | `?as=client` |
| Amara Studio (the freelancer) | freelancer | `?as=freelancer` |
| Tethran operator (Earnings, limits) | operator | `?as=operator` (used in Kofi's window for d7 and d8) |

Signing buttons with a flask icon sign with a test key held by the demo signer; the result says "Signed with a test
key". Kofi's and Amara's Tethran wallets are WDK test wallets on Sepolia.

### Typical waits (pause the recording here)

Measured on Sepolia: a transaction normally confirms in 30 to 40 seconds. On a congested day it can take many
minutes (on 13 Nov three activations took 15 minutes); the app waits up to 25 minutes per transaction.

| Where | What waits | Normal | Slow day |
|---|---|---|---|
| d1 Sign and send | three milestones created on-chain | 2 to 3 min | up to 15+ min |
| d2 Emails | invoice email (Resend) | 1 to 5 s | up to 1 min (retries) |
| d3 Add funds | test USDT minted to Kofi's wallet | 30 to 60 s | several min |
| d3 Confirm and pay | Kofi's transfer, then escrow funded | 1 to 2 min | several min |
| d4 Submit delivery | the AI's delivery check (live model) | 5 to 20 s | 1 min (replay fallback) |
| d5 Approve work | escrow approve from Kofi's wallet | 30 to 60 s | several min |
| d5 Release and settle | release, agent, Policy, two vault payouts, receipt | 2 to 4 min | 15+ min |
| d8 Change limit (twice) | the vault's limit, relayed on-chain | 30 to 60 s each | several min |
| d8 Ask the vault, d9 Verify | read only | 1 to 3 s | 10 s |
| Bells and dashboards | refresh every 2 seconds | 2 to 4 s | |

## The steps

Kofi's window = **K**, Amara's window = **A**. "Idle" means leave that window on the screen named, so its bell and
Home show the other side's action arriving (the bell is at the top right; everything important is above the fold).

### d1 (9.5 s): Amara creates the contract; Kofi idle
- **K** (client): `http://localhost:3000/app/dashboard?as=client`. Idle.
- **A** (freelancer): `http://localhost:3000/app/dashboard?as=freelancer`.
  1. Click **Create contract**. (Step 1 of 4, Parties) Client name: `Kofi Mensah Ltd` (prefilled). Client email:
     type `delivered@resend.dev` (Resend's test inbox: the email is really sent, no person receives it). Click
     **Continue**.
  2. (Step 2 of 4, Milestones) Milestone 1: Title `Brand identity`, Amount `400`, Done when
     `Logo as SVG and PNG; brand colours with hex codes; one-page usage guide`. Click **Add milestone**: `Landing
     page`, `600`, `Page live on a test URL; mobile layout checked; copy approved`. **Add milestone**:
     `Social media kit`, `300`, `Ten post templates; profile and cover images for three platforms`. **Continue**.
  3. (Step 3 of 4, Review) **Continue**. (Step 4 of 4, Sign) tick **I agree to these milestones**, click
     **Sign and send** (flask). **Chain wait** (see table). It lands on the invoice: `INV-…`, $400, "Platform fee 5%:
     $20, deducted from the freelancer's payout", the pay link and QR.
- On screen at the end: A on the invoice page; K on Home.

### d2 (5.5 s): the invoice email; Kofi's bell; Kofi opens the pay link
- **A**: click the bell (top right), then **Emails**. The newest email shows **SENT** (or **sending…**; it turns
  to sent within seconds; if it shows **Failed, retry**, click it), the subject `Invoice INV-… from Amara Studio:
  $400.00`, and `Pay link: http://localhost:3000/pay/…`.
- **K**: the bell shows a number. Click the bell: the notification "Invoice INV-… from Amara Studio" is on top. Click it: it opens
  the pay page `http://localhost:3000/pay/<invoiceId>`.

### d3 (19 s): Kofi adds $400 by card (simulated) and pays from his wallet; Connect wallet; Amara's bell
- **A**: `http://localhost:3000/app/dashboard?as=freelancer`. Idle.
- **K**:
  1. Open `http://localhost:3000/app/wallet?as=client` (the pay page has no app menu). Tab **Kofi Mensah Ltd
     (client)** is selected. In **Add funds** (labelled **Simulated**) type `400` in **Amount to add** and click
     **Add funds**. **Chain wait**. The balance rises by $400 and the activity shows "Added by card (simulated)".
  2. Go back to the pay page (browser Back twice, or the link from the bell). Choose **Tethran wallet**: it shows
     Kofi's balance in test USDT. The fee note reads "Platform fee 5%, deducted from the freelancer's payout".
     Click **Confirm and pay $400**. **Chain wait**. "Funds locked." The status is funded.
  3. About 3 seconds: click **Connect wallet** (top right). The wallet list opens (MetaMask, WalletConnect and
     others; this browser has no wallet extension, so just show it). Press **Esc** to close.
- **A**: the bell shows a number. Click it: "Funded: Brand identity" on top.

### d4 (6.5 s): Amara submits milestone 1; Kofi's bell
- **K**: `http://localhost:3000/app/dashboard?as=client`. Idle.
- **A**: open milestone 1 (Home, under **Active milestones**, **Brand identity**, or the "Funded: Brand identity" notification), with
  `?as=freelancer`. In **Evidence**: Delivery note `Brand identity delivered: logo files, colours and the usage
  guide.`; Delivery link `https://drive.example.com/kofi-brand-kit`; Files: choose a small text file named
  `brand-kit-notes.md`, for example:
  ```
  # Kofi Mensah Ltd brand kit
  - Logo: logo.svg and logo.png, light and dark versions
  - Colours: Forest #0A1F1B, Lime #C6F24E, Sand #F4F1EA
  - Usage guide: one page with clear space, minimum sizes and colour pairs
  ```
  Click **Submit delivery**. Wait 5 to 20 s: **The AI's delivery check** appears, one line per criterion (met,
  unmet or unclear) with a **Live model** or **Replay** tag.
- **K**: the bell shows a number. Click it: "Work submitted: Brand identity" is on top.

### d5 (11 s): Kofi approves; the AI's activity and its proposal
- **A**: `http://localhost:3000/app/dashboard?as=freelancer`. Idle.
- **K**: open milestone 1 with `?as=client` (from the "Work submitted: Brand identity" notification). Scroll to the delivery check.
  1. Click **Approve work** (signed by Kofi's Tethran wallet). **Chain wait**: "Work approved on-chain".
  2. In the **Platform step** card click **Release and settle** (flask). **Chain wait** (the longest one). It ends
     with "Paid out" and **View the receipt**.
  3. Reload the page (so the activity lines appear one by one), then scroll to **AI activity**: Read the milestone,
     Read the delivery (with `brand-kit-notes.md`), Checked each criterion, Proposed the payout. Hold 3 to 4 s on the
     proposal box: Amara Studio $340, Tethran earnings account $20 (the 5% fee), the tax reserve note, and
     **Confidence NN%**.

### d6 (10 s): the Policy Service decision and the two signatures
- **K** (same page): scroll to **Policy Service: approved** with the rules that passed. Hold 2 s. Then point at
  **Two signatures on every transfer**: 1. Agent signer, 2. Policy Service; the vault checks both. Hold 2 s.
- **A**: idle on Home.

### d7 (9 s): Amara's wallet shows the payout; Operator Earnings shows the fee
- **A**: `http://localhost:3000/app/wallet?as=freelancer`, tab **Amara Studio (freelancer)**. Scroll to the activity:
  the payout received from the vault ($340 test USDT). Hold at least 3 s.
- **K**: `http://localhost:3000/app/earnings?as=operator`: Tethran earnings, the $20 fee line for this milestone and
  the total collected. Hold.
- No mobile-money step: Amara is paid in test USDT to her wallet.

### d8 (8 s): the operator lowers the cap to $5; the vault refuses $6; restore
- **A**: `http://localhost:3000/app/dashboard?as=freelancer`. Idle.
- **K**: `http://localhost:3000/app/operator?as=operator`. Open it 10 to 20 s before you record this step: it reads the
  limits from the chain and shows grey placeholders until they arrive.
  1. **New per-payment limit**: `5`, click **Change limit** (flask). **Chain wait**: the per-payment limit shows $5.
  2. **Test payout amount**: `6`, click **Ask the vault**. In 1 to 3 s: "Refused by the vault" with
     **OVER_PER_TX_CAP**. Hold 2 s.
  3. Restore: **New per-payment limit** `1000`, **Change limit**. **Chain wait**: shows $1,000.

### d9 (8.5 s): the receipt, verified
- **K**: on milestone 1 click **View the receipt** (or open `http://localhost:3000/receipt/<milestoneId>`; the id is
  in the milestone page URL). Click **Verify**: "Matches the record on the test network". Hold 2 s.
- **A**: Home: milestone 1 paid, the receipt listed.

### d10 (8.5 s): both dashboards, ending on the receipt
- **K**: `http://localhost:3000/app/dashboard?as=client`; **A**: `http://localhost:3000/app/dashboard?as=freelancer`.
  Hold 3 s on both.
- Then both open `http://localhost:3000/receipt/<milestoneId>`. Hold 3 s. End.

## Reset the vault cap after d8

d8 already restores it. If the restore was skipped or failed: Kofi's window, `http://localhost:3000/app/operator?as=operator`,
**New per-payment limit** `1000`, **Change limit**, wait until the per-payment limit shows **$1,000**. Until then any
payout over $5 is refused by the vault (a later settlement would stop with OVER_PER_TX_CAP).

## If a step errors

- **Do not click the same button again.** Payments and signatures carry idempotency keys and a duplicate-send block;
  a second click can show "already sent" or wait on the first. Wait for the first to finish.
- **Reload the page.** All state lives on the chain and in the backend; the page picks up where it is. The bells and
  Home refresh every 2 seconds.
- **"The Tethran server can't be reached"**: look at the terminal running `npm run record`. If it stopped, run it
  again (no reseed needed; the data is kept).
- **A chain wait that does not end**: Sepolia is slow. The app keeps polling for up to 25 minutes per transaction;
  pause the recording and wait. If it fails after that, reload and continue from the milestone page (the steps can be
  resumed in place).
- **The invoice email shows Failed**: click **Failed, retry** in Emails. It never blocks the flow; Kofi can open the
  pay link from the bell either way.
- **The delivery check shows Replay instead of Live model**: the live model did not answer in time; the labelled
  replay answer is used. Fine to continue.
- **Start over from a clean state**: stop with Ctrl+C, reseed (about 40 minutes), `npm run record` again.

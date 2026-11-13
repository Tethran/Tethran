// Sends one test invoice email to TEST_EMAIL through the configured provider (EMAIL_PROVIDER, EMAIL_API_KEY,
// EMAIL_FROM in the repo-root .env). Prints only the status and the provider message id (or the error text, without
// any key). Never prints the recipient or the key.   npx tsx scripts/send-test-email.ts
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { createMailer, emailConfigFromEnv } from "../src/email";

const env = parse(readFileSync(resolve(__dirname, "../../../.env")));
const to = (env.TEST_EMAIL ?? "").trim();
if (!to) { console.log("status: not sent (TEST_EMAIL is empty)"); process.exit(1); }
const base = (env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const mailer = createMailer({ db: new DatabaseSync(":memory:"), config: emailConfigFromEnv(env as NodeJS.ProcessEnv), now: () => new Date() });

(async () => {
  const r = await mailer.sendInvoice({
    invoiceId: `test-${Date.now()}`, number: "INV-TEST-0001", to, senderName: "Amara Studio", clientName: "Kofi Mensah Ltd",
    amountCents: 40_000, description: "Logo design (test email)", payUrl: `${base}/pay/test`,
  });
  console.log(`status: ${r.status}`);
  if (r.provider_message_id) console.log(`provider message id: ${r.provider_message_id}`);
  if (r.error) console.log(`error: ${r.error}`);
})();

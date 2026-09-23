/**
 * Check your whole setup without changing anything anywhere.
 *
 *   npm run check-setup            check config, Bitrix24 and Razorpay
 *   npm run check-setup -- 42      also do a dry run for deal 42: show exactly
 *                                  what would be sent to Razorpay (nothing is sent)
 *
 * Every step is read-only: no payment link is created and no deal is modified.
 * Run it after filling in .env, and again whenever something stops working.
 */

import { BitrixClient, BitrixError } from "../src/bitrix.ts";
import { getConfig } from "../src/config.ts";
import { RazorpayApiError, RazorpayClient, buildPaymentLinkPayload, formatMoney, toPaise } from "../src/razorpay.ts";

const ok = (msg: string) => console.log(`  [OK]   ${msg}`);
const fail = (msg: string) => console.log(`  [FAIL] ${msg}`);
const info = (msg: string) => console.log(`         ${msg}`);
let failures = 0;

// ------------------------------------------------------------------ 1. config
console.log("\n1. Configuration (.env)");
let config;
try {
  config = getConfig();
  ok("All required variables are present and valid");
  info(`Razorpay mode: ${config.razorpayKeyId.startsWith("rzp_test_") ? "TEST (no real money)" : "LIVE (real money!)"}`);
  info(`Move deal to Won on payment: ${config.moveDealToWon}`);
} catch (err) {
  fail((err as Error).message);
  process.exit(1); // nothing else can run without config
}

const bitrix = new BitrixClient(config.bitrixWebhookUrl);
const razorpay = new RazorpayClient(config.razorpayKeyId, config.razorpayKeySecret.reveal());

// ------------------------------------------------------------------ 2. Bitrix24
console.log("\n2. Bitrix24");
try {
  const fields = await bitrix.listDealFields();
  ok(`Connected to ${new URL(config.bitrixWebhookUrl).host}`);
  for (const [envName, fieldName] of [
    ["BITRIX_PAYMENT_LINK_FIELD", config.bitrixPaymentLinkField],
    ["BITRIX_PAYMENT_ID_FIELD", config.bitrixPaymentIdField],
  ] as const) {
    const def = fields[fieldName];
    if (!def) {
      fail(`${envName}=${fieldName} does not exist on deals. Run: npm run list-fields`);
      failures++;
      continue;
    }
    const label = String(def.listLabel || def.formLabel || fieldName);
    ok(`${envName}: ${fieldName} ("${label}", type ${String(def.type)})`);
    if (def.isMultiple) info("  Warning: this field allows multiple values. A normal single-value field is simpler.");
    if (!["string", "url"].includes(String(def.type))) {
      info(`  Warning: type "${String(def.type)}" may not accept text. Use a String field.`);
    }
  }
} catch (err) {
  fail((err as Error).message);
  info("Check the webhook URL and that the inbound webhook has the CRM permission.");
  failures++;
}

// ------------------------------------------------------------------ 3. Razorpay
console.log("\n3. Razorpay");
try {
  await razorpay.verifyCredentials();
  ok(`API keys work (${config.razorpayKeyId})`);
} catch (err) {
  fail((err as Error).message);
  if (err instanceof RazorpayApiError && err.isAuthError) {
    info("Wrong key id/secret, or a test key paired with a live secret. Regenerate keys in the dashboard if unsure.");
  }
  failures++;
}

// ------------------------------------------------------------------ 4. dry run for a deal
const dealArg = process.argv[2];
if (dealArg) {
  console.log(`\n4. Dry run for deal ${dealArg} (nothing is sent to Razorpay)`);
  try {
    const deal = await bitrix.getDealWithContact(dealArg);
    ok(`Deal found: "${deal.title}"`);
    info(`Amount: ${deal.amount?.toString() ?? "(none)"} ${deal.currency}   Pipeline (category): ${deal.categoryId}`);
    info(`Contact: ${deal.contact ? JSON.stringify(deal.contact) : "(no contact linked; the customer types their details on the payment page)"}`);

    if (!deal.amount) {
      fail("The deal has no amount. Set the deal's amount field (OPPORTUNITY) first.");
      failures++;
    } else {
      const paise = toPaise(deal.amount); // throws for zero/negative
      ok(`Would charge ${formatMoney(paise, deal.currency)} (${paise} paise)`);
      const payload = buildPaymentLinkPayload(
        {
          amount: deal.amount,
          currency: deal.currency,
          description: deal.title,
          dealId: deal.id,
          customer: deal.contact,
          acceptPartial: config.razorpayAcceptPartial,
          expireInDays: config.paymentLinkExpireDays,
        },
        deal.id,
      );
      info("Request body that would be sent to POST /v1/payment_links:");
      console.log(JSON.stringify(payload, null, 2).replace(/^/gm, "           "));
    }
  } catch (err) {
    fail((err as Error).message);
    if (!(err instanceof BitrixError)) info("(This is the same check the real endpoint does before contacting Razorpay.)");
    failures++;
  }
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
// Set exitCode rather than calling process.exit(): exiting while fetch still has
// open connections trips a Node-on-Windows crash ("UV_HANDLE_CLOSING").
process.exitCode = failures === 0 ? 0 : 1;

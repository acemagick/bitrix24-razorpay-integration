/**
 * Send a fake Razorpay webhook to your local server, signed exactly the way
 * Razorpay signs real ones. Lets you test flow 2 without a Razorpay account.
 *
 *   npm run send-webhook -- <event> <dealId> [options]
 *
 *   events:  paid | partial | expired | cancelled | failed | other
 *   options: --amount 11.80        link amount in rupees (default 100)
 *            --twice               send the same event twice (tests duplicate protection)
 *            --bad-signature       sign with the wrong secret (should get HTTP 400)
 *            --url http://...      server address, or the full /webhooks/razorpay URL
 *                                  (default http://localhost:PORT)
 *
 *   e.g.  npm run send-webhook -- paid 54 --amount 11.80
 *
 * The server must be running (npm run dev) with the same RAZORPAY_WEBHOOK_SECRET.
 * The payloads copy the structure of real Razorpay webhooks, but the IDs are fake.
 * The server will post real comments on the Bitrix deal you name.
 */

import { createHmac, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import Big from "big.js";

import { loadDotEnv } from "../src/config.ts";

loadDotEnv();

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    amount: { type: "string", default: "100" },
    twice: { type: "boolean", default: false },
    "bad-signature": { type: "boolean", default: false },
    url: { type: "string" },
  },
});

const [eventArg, dealId] = positionals;
const eventNames: Record<string, string> = {
  paid: "payment_link.paid",
  partial: "payment_link.partially_paid",
  expired: "payment_link.expired",
  cancelled: "payment_link.cancelled",
  failed: "payment.failed",
  other: "refund.created", // an event we don't handle: should be ignored
};
const event = eventArg ? eventNames[eventArg] : undefined;
if (!event || !dealId || !/^\d+$/.test(dealId)) {
  console.error("Usage: npm run send-webhook -- <paid|partial|expired|cancelled|failed|other> <dealId> [--amount 11.80] [--twice] [--bad-signature]");
  process.exit(1);
}

const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!secret) {
  console.error("RAZORPAY_WEBHOOK_SECRET is not set in .env");
  process.exit(1);
}

// --url may be just the server ("http://localhost:8000", an ngrok address...) or
// the full endpoint. Add the webhook path unless it's already there.
const WEBHOOK_PATH = "/webhooks/razorpay";
const target = new URL(values.url ?? `http://localhost:${process.env.PORT || 8000}`);
const basePath = target.pathname.replace(/\/+$/, "");
if (!basePath.endsWith(WEBHOOK_PATH)) target.pathname = `${basePath}${WEBHOOK_PATH}`;
const url = target.href;
const id = (prefix: string) => `${prefix}_Test${randomBytes(5).toString("hex")}`;
const amount = new Big(values.amount).times(100).round(0, Big.roundHalfUp).toNumber(); // paise
const now = Math.floor(Date.now() / 1000);
const notes = { bitrix_deal_id: dealId };

// ---- build the payload, shaped like Razorpay's real webhooks
const linkId = id("plink");
const orderId = id("order");
const paymentLink = (status: string, amountPaid: number) => ({
  entity: {
    id: linkId,
    entity: "payment_link",
    amount,
    amount_paid: amountPaid,
    currency: "INR",
    status,
    reference_id: dealId,
    short_url: "https://rzp.io/rzp/TestLink",
    order_id: orderId,
    notes,
  },
});
const payment = (paid: number, extra: Record<string, unknown> = {}) => ({
  entity: {
    id: id("pay"),
    entity: "payment",
    amount: paid,
    currency: "INR",
    status: "captured",
    order_id: orderId,
    method: "upi",
    notes, // real payment.failed payloads may not include notes; the server falls back to the order
    created_at: now,
    ...extra,
  },
});
const half = Math.floor(amount / 2);

const payloads: Record<string, Record<string, unknown>> = {
  "payment_link.paid": { payment_link: paymentLink("paid", amount), payment: payment(amount) },
  "payment_link.partially_paid": { payment_link: paymentLink("partially_paid", half), payment: payment(half) },
  "payment_link.expired": { payment_link: paymentLink("expired", 0) },
  "payment_link.cancelled": { payment_link: paymentLink("cancelled", 0) },
  "payment.failed": {
    payment: payment(amount, {
      status: "failed",
      error_code: "BAD_REQUEST_ERROR",
      error_description: "Your payment has been declined by the bank",
      error_reason: "payment_declined",
      error_source: "bank",
    }),
  },
  "refund.created": {},
};

const body = JSON.stringify({
  entity: "event",
  account_id: "acc_TestAccount",
  event,
  contains: Object.keys(payloads[event] ?? {}),
  payload: payloads[event],
  created_at: now,
});

// ---- sign exactly like Razorpay: HMAC-SHA256 of the raw body, hex-encoded
const signingSecret = values["bad-signature"] ? "definitely-the-wrong-secret" : secret;
const signature = createHmac("sha256", signingSecret).update(body).digest("hex");
const eventId = id("evt"); // the same ID on both sends when --twice, like a real Razorpay retry

// A correctly signed webhook must be accepted (200); a badly signed one must be
// rejected (400). Anything else means the test failed, and the exit code says so.
const expectedStatus = values["bad-signature"] ? 400 : 200;

/**
 * The acknowledgment the server should send for send number `i`:
 *   - events we don't handle: "ignored" every time (answered before the duplicate check)
 *   - handled events: "accepted" the first time, "duplicate" on the --twice resend
 *   - bad signature: no acknowledgment, just the 400 error, so only the status is checked
 */
function expectedAck(i: number): string | undefined {
  if (values["bad-signature"]) return undefined;
  if (event === eventNames.other) return "ignored";
  return i === 1 ? "accepted" : "duplicate";
}

for (let i = 1; i <= (values.twice ? 2 : 1); i++) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signature, "X-Razorpay-Event-Id": eventId },
      body,
    });
    const text = await response.text();
    let ack: unknown;
    try {
      ack = (JSON.parse(text) as { status?: unknown }).status;
    } catch {
      ack = undefined; // not JSON: can't match an expected acknowledgment
    }

    const wantAck = expectedAck(i);
    const problems = [
      response.status !== expectedStatus && `expected HTTP ${expectedStatus}`,
      wantAck !== undefined && ack !== wantAck && `expected status "${wantAck}"`,
    ].filter(Boolean);

    console.log(
      `Send #${i}: ${event} for deal ${dealId} -> HTTP ${response.status} ${text}` +
        (problems.length ? `   FAILED: ${problems.join(", ")}` : ""),
    );
    if (problems.length) process.exitCode = 1;
  } catch (err) {
    console.error(`Could not reach ${url}. Is the server running (npm run dev)?`, (err as Error).message);
    process.exitCode = 1;
    break;
  }
}

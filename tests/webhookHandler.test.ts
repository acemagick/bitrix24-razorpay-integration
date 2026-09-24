import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RazorpayWebhookSchema } from "../src/models.ts";
import {
  ProcessedEventStore,
  buildComment,
  dedupeKey,
  processWebhook,
  resolveDealId,
  verifySignature,
} from "../src/webhookHandler.ts";
import {
  createFakeBitrix,
  createFakeRazorpay,
  deal,
  json,
  linkEntity,
  makeTempDir,
  paymentEntity,
  sign,
  webhookBody,
} from "./helpers.ts";

const parse = (body: string) => RazorpayWebhookSchema.parse(JSON.parse(body));

// --------------------------------------------------------------------------- signature

describe("verifySignature", () => {
  const body = webhookBody("payment_link.paid", { payment_link: linkEntity() });

  it("accepts the signature Razorpay would send", () => {
    expect(verifySignature(Buffer.from(body), sign(body), "webhook-secret")).toBe(true);
  });

  it("accepts an upper-case hex signature", () => {
    expect(verifySignature(Buffer.from(body), sign(body).toUpperCase(), "webhook-secret")).toBe(true);
  });

  it.each([
    ["a tampered body", body.replace("paid", "cancelled"), sign(body), "webhook-secret"],
    ["the wrong secret", body, sign(body, "someone-elses-secret"), "webhook-secret"],
    ["a truncated signature", body, sign(body).slice(0, 10), "webhook-secret"],
    ["no signature", body, undefined, "webhook-secret"],
  ])("rejects %s", (_label, sentBody, signature, secret) => {
    expect(verifySignature(Buffer.from(sentBody), signature, secret)).toBe(false);
  });

  it("fails for re-serialised JSON: this is why we must check the RAW body", () => {
    const raw = '{ "event" : "payment_link.paid" }';
    const reserialised = JSON.stringify(JSON.parse(raw)); // same data, different spacing
    expect(verifySignature(Buffer.from(reserialised), sign(raw), "webhook-secret")).toBe(false);
  });
});

// --------------------------------------------------------------------------- idempotency

describe("dedupeKey", () => {
  it("uses Razorpay's event id header when present", () => {
    expect(dedupeKey("evt_123", parse(webhookBody("payment.failed", { payment: paymentEntity() })))).toBe("evt_123");
  });

  it("falls back to event + entity + time", () => {
    expect(dedupeKey(undefined, parse(webhookBody("payment.failed", { payment: paymentEntity() })))).toBe(
      "payment.failed:pay_XYZ:1727000000",
    );
  });
});

describe("ProcessedEventStore", () => {
  it("says yes the first time and no for a repeat", async () => {
    const store = new ProcessedEventStore(join(await makeTempDir(), "events.json"));
    expect(store.claim("evt_1")).toBe(true);
    expect(store.claim("evt_1")).toBe(false);
    expect(store.claim("evt_2")).toBe(true);
    // claim() saves in the background; wait for it, or the temp folder cleanup
    // races with the write (a flaky ENOTEMPTY on Windows).
    await store.flush();
  });

  it("remembers events across a restart", async () => {
    const path = join(await makeTempDir(), "nested", "events.json"); // folder is created on first save
    const before = new ProcessedEventStore(path);
    before.claim("evt_1");
    await before.flush();

    const after = new ProcessedEventStore(path);
    await after.load();
    expect(after.claim("evt_1")).toBe(false);
  });

  it("drops the oldest IDs beyond its limit", async () => {
    const path = join(await makeTempDir(), "events.json");
    const store = new ProcessedEventStore(path, 2);
    for (const id of ["evt_1", "evt_2", "evt_3"]) store.claim(id);
    await store.flush();
    expect(JSON.parse(await readFile(path, "utf8")).map(([id]: [string]) => id)).toEqual(["evt_2", "evt_3"]);
    expect(store.has("evt_1")).toBe(false);
  });

  it("starts empty instead of crashing when the file is corrupt", async () => {
    const path = join(await makeTempDir(), "events.json");
    await writeFile(path, "{ not json");
    const store = new ProcessedEventStore(path);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.claim("evt_1")).toBe(true);
    await store.flush(); // see "says yes the first time"
  });
});

// --------------------------------------------------------------------------- which deal?

describe("resolveDealId", () => {
  const noOrders = createFakeRazorpay().client;

  it("prefers notes.bitrix_deal_id on the payment link", async () => {
    const webhook = parse(webhookBody("payment_link.paid", { payment_link: linkEntity({ reference_id: "99" }) }));
    expect(await resolveDealId(webhook, noOrders)).toEqual({ dealId: "42", source: "payment_link.notes" });
  });

  it('falls back to the reference_id, stripping a "-3" suffix', async () => {
    const webhook = parse(
      webhookBody("payment_link.paid", { payment_link: linkEntity({ notes: [], reference_id: "77-3" }) }),
    );
    expect(await resolveDealId(webhook, noOrders)).toEqual({ dealId: "77", source: "payment_link.reference_id" });
  });

  it("ignores a hand-made reference like INV-001", async () => {
    const webhook = parse(
      webhookBody("payment_link.paid", { payment_link: linkEntity({ notes: [], reference_id: "INV-001" }) }),
    );
    expect(await resolveDealId(webhook, noOrders)).toBeUndefined();
  });

  it("uses the payment's notes for payment.failed", async () => {
    const webhook = parse(webhookBody("payment.failed", { payment: paymentEntity({ notes: { bitrix_deal_id: "42" } }) }));
    expect(await resolveDealId(webhook, noOrders)).toEqual({ dealId: "42", source: "payment.notes" });
  });

  it("as a last resort, asks Razorpay for the order", async () => {
    const rzp = createFakeRazorpay();
    rzp.orders.set("order_123", { id: "order_123", receipt: null, notes: { bitrix_deal_id: "42" } });
    const webhook = parse(webhookBody("payment.failed", { payment: paymentEntity() }));
    expect(await resolveDealId(webhook, rzp.client)).toEqual({ dealId: "42", source: "fetched order.notes" });
  });

  it("returns undefined for payments unrelated to our links (e.g. website checkout)", async () => {
    const rzp = createFakeRazorpay();
    rzp.orders.set("order_123", { id: "order_123", receipt: "web-1", notes: [] });
    const webhook = parse(webhookBody("payment.failed", { payment: paymentEntity() }));
    expect(await resolveDealId(webhook, rzp.client)).toBeUndefined();
  });

  it("returns undefined (not an error) when the order lookup fails", async () => {
    const rzp = createFakeRazorpay();
    rzp.failOn("GET /orders/:id", () => json(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }));
    const webhook = parse(webhookBody("payment.failed", { payment: paymentEntity() }));
    expect(await resolveDealId(webhook, rzp.client)).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- comment text

describe("buildComment", () => {
  it("payment_link.paid: amount, payment ID, method and link", () => {
    const comment = buildComment(
      parse(webhookBody("payment_link.paid", { payment_link: linkEntity({ amount_paid: 149_999 }), payment: paymentEntity() })),
    );
    expect(comment).toBe(
      [
        "Razorpay: Payment successful",
        "Amount paid: ₹1,499.99",
        "Payment ID: pay_XYZ",
        "Method: upi",
        "Payment link: https://rzp.io/rzp/abc (plink_ABC)",
      ].join("\n"),
    );
  });

  it("payment_link.paid after instalments: shows the total and the final part", () => {
    const comment = buildComment(
      parse(
        webhookBody("payment_link.paid", {
          payment_link: linkEntity({ amount_paid: 149_999 }),
          payment: paymentEntity({ amount: 49_999 }),
        }),
      ),
    );
    expect(comment).toContain("Amount paid: ₹1,499.99");
    expect(comment).toContain("This payment: ₹499.99 (final part of a partial payment)");
  });

  it("payment_link.partially_paid: paid so far vs still due", () => {
    const comment = buildComment(
      parse(
        webhookBody("payment_link.partially_paid", {
          payment_link: linkEntity({ amount_paid: 100_000 }),
          payment: paymentEntity({ amount: 100_000 }),
        }),
      ),
    );
    expect(comment).toContain("Paid so far: ₹1,000.00 of ₹1,499.99");
    expect(comment).toContain("Still due: ₹499.99");
  });

  it("payment_link.expired: says it expired unpaid", () => {
    const comment = buildComment(parse(webhookBody("payment_link.expired", { payment_link: linkEntity() })));
    expect(comment).toMatch(/^Razorpay: Payment link expired unpaid\nAmount due: ₹1,499.99/);
  });

  it("payment_link.expired after a partial payment: says how much was paid", () => {
    const comment = buildComment(
      parse(webhookBody("payment_link.expired", { payment_link: linkEntity({ amount_paid: 50_000 }) })),
    );
    expect(comment).toContain("expired with only ₹500.00 of ₹1,499.99 paid");
  });

  it("payment_link.cancelled", () => {
    expect(buildComment(parse(webhookBody("payment_link.cancelled", { payment_link: linkEntity() })))).toMatch(
      /^Razorpay: Payment link cancelled/,
    );
  });

  it("payment.failed: gives the reason and says it isn't final", () => {
    const comment = buildComment(
      parse(
        webhookBody("payment.failed", {
          payment: paymentEntity({
            status: "failed",
            error_description: "Your payment has been declined by the bank",
            error_reason: "payment_declined",
          }),
        }),
      ),
    );
    expect(comment).toContain("Reason: Your payment has been declined by the bank (payment_declined)");
    expect(comment).toContain("the customer can retry");
  });

  it("returns undefined for events we don't comment on", () => {
    expect(buildComment(parse(webhookBody("refund.created")))).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- process

describe("processWebhook", () => {
  const paid = () =>
    parse(webhookBody("payment_link.paid", { payment_link: linkEntity({ amount_paid: 149_999 }), payment: paymentEntity() }));

  it("posts the comment on the right deal", async () => {
    const bitrix = createFakeBitrix();
    const outcome = await processWebhook(paid(), { bitrix: bitrix.client, razorpay: createFakeRazorpay().client, moveDealToWon: false });
    expect(outcome).toEqual({ status: "done", dealId: "42", commented: true });
    expect(bitrix.comments("42")).toHaveLength(1);
    expect(bitrix.callsTo("crm.deal.update")).toHaveLength(0);
  });

  it("moves the deal to its pipeline's Won stage when enabled", async () => {
    const bitrix = createFakeBitrix();
    bitrix.deals.set("42", deal({ ID: "42", CATEGORY_ID: "3" }));
    const outcome = await processWebhook(paid(), { bitrix: bitrix.client, razorpay: createFakeRazorpay().client, moveDealToWon: true });
    expect(outcome).toMatchObject({ status: "done", movedToWon: true });
    expect(bitrix.deals.get("42")?.STAGE_ID).toBe("C3:WON");
  });

  it("comments (instead of failing) when the move to Won is refused", async () => {
    const bitrix = createFakeBitrix();
    bitrix.deals.set("42", deal({ ID: "42" }));
    bitrix.failOn("crm.deal.update", () => json(200, { error: "ACCESS_DENIED", error_description: "Access denied" }));
    const outcome = await processWebhook(paid(), { bitrix: bitrix.client, razorpay: createFakeRazorpay().client, moveDealToWon: true });
    expect(outcome).toMatchObject({ status: "done", commented: true, movedToWon: false });
    expect(bitrix.comments("42")[1]).toMatch(/could not be moved to Won automatically: .*ACCESS_DENIED/);
  });

  it("only moves to Won on payment_link.paid", async () => {
    const bitrix = createFakeBitrix();
    const failed = parse(webhookBody("payment.failed", { payment: paymentEntity({ notes: { bitrix_deal_id: "42" } }) }));
    await processWebhook(failed, { bitrix: bitrix.client, razorpay: createFakeRazorpay().client, moveDealToWon: true });
    expect(bitrix.callsTo("crm.deal.update")).toHaveLength(0);
  });

  it("ignores events it doesn't handle", async () => {
    const bitrix = createFakeBitrix();
    const outcome = await processWebhook(parse(webhookBody("refund.created")), {
      bitrix: bitrix.client,
      razorpay: createFakeRazorpay().client,
      moveDealToWon: false,
    });
    expect(outcome.status).toBe("ignored");
    expect(bitrix.calls).toHaveLength(0);
  });

  it("skips payments that don't belong to any deal", async () => {
    const outcome = await processWebhook(parse(webhookBody("payment.failed", { payment: paymentEntity({ order_id: null }) })), {
      bitrix: createFakeBitrix().client,
      razorpay: createFakeRazorpay().client,
      moveDealToWon: false,
    });
    expect(outcome).toEqual({ status: "no_deal" });
  });

  it("never throws, even when Bitrix is completely down", async () => {
    const bitrix = createFakeBitrix();
    bitrix.failOn("crm.timeline.comment.add", () => new Response("<html>down</html>", { status: 503 }));
    await expect(
      processWebhook(paid(), { bitrix: bitrix.client, razorpay: createFakeRazorpay().client, moveDealToWon: false }),
    ).resolves.toEqual({ status: "done", dealId: "42", commented: false });
  });
});

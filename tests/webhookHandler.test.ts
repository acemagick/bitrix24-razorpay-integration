import { readFile, rm, writeFile } from "node:fs/promises";
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
  it("says yes the first time and no for a repeat, whether in progress or done", async () => {
    const store = new ProcessedEventStore(join(await makeTempDir(), "events.json"));
    expect(store.claim("evt_1")).toBe(true);
    expect(store.claim("evt_1")).toBe(false);
    expect(store.has("evt_1")).toBe(false); // claimed, not processed yet
    store.complete("evt_1");
    expect(store.claim("evt_1")).toBe(false);
    expect(store.has("evt_1")).toBe(true);
    expect(store.claim("evt_2")).toBe(true);
    // complete() saves in the background; wait for it, or the temp folder cleanup
    // races with the write (a flaky ENOTEMPTY on Windows).
    await store.flush();
  });

  it("retries a failed save when asked to make sure a processed event is on disk", async () => {
    const blocker = join(await makeTempDir(), "not-a-folder");
    await writeFile(blocker, ""); // a file where the folder should be: saves fail
    const path = join(blocker, "events.json");
    const store = new ProcessedEventStore(path);
    store.claim("evt_1");
    await expect(store.complete("evt_1")).rejects.toThrow();
    expect(store.has("evt_1")).toBe(true); // processed, just not on disk
    await expect(store.ensureSaved("evt_1")).rejects.toThrow();

    await rm(blocker);
    await expect(store.ensureSaved("evt_1")).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8")).map(([id]: [string]) => id)).toEqual(["evt_1"]);
    await expect(store.ensureSaved("evt_1")).resolves.toBeUndefined(); // nothing left to save
  });

  it("doesn't let an earlier save clear a newer completion's unsaved marker", async () => {
    // With room for one ID: A is saved, dropped for B, then processed again.
    const store = new ProcessedEventStore(join(await makeTempDir(), "events.json"), 1);
    // Looked at directly: from outside, the marker only shows up as timing.
    const unsaved = (store as unknown as { unsaved: Map<string, number> }).unsaved;
    store.claim("A");
    const firstSave = store.complete("A"); // save 1: [A]
    store.claim("B");
    void store.complete("B"); // A dropped; save 2: [B]
    store.claim("A");
    void store.complete("A"); // A again; save 3: [A]

    await firstSave; // saves 2 and 3 haven't run yet
    expect(unsaved.has("A")).toBe(true); // save 1 was the OLD completion of A
    await store.flush();
    expect(unsaved.size).toBe(0);
  });

  it("lets a released claim be processed again", () => {
    const store = new ProcessedEventStore("unused.json");
    expect(store.claim("evt_1")).toBe(true);
    store.release("evt_1");
    expect(store.claim("evt_1")).toBe(true);
  });

  it("remembers completed events across a restart, but not unfinished claims", async () => {
    const path = join(await makeTempDir(), "nested", "events.json"); // folder is created on first save
    const before = new ProcessedEventStore(path);
    before.claim("evt_done");
    before.complete("evt_done");
    before.claim("evt_unfinished"); // e.g. the process died while this one was being processed
    await before.flush();

    const after = new ProcessedEventStore(path);
    await after.load();
    expect(after.claim("evt_done")).toBe(false);
    expect(after.claim("evt_unfinished")).toBe(true);
  });

  it("drops the oldest IDs beyond its limit", async () => {
    const path = join(await makeTempDir(), "events.json");
    const store = new ProcessedEventStore(path, 2);
    for (const id of ["evt_1", "evt_2", "evt_3"]) store.complete(id);
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

/**
 * Fakes where deal 42 has plink_ABC (the link linkEntity() describes, with
 * order_123 like paymentEntity()) saved in its Link ID field, as this service
 * does when it creates a link.
 */
function webhookSetup() {
  const bitrix = createFakeBitrix();
  bitrix.deals.set("42", deal({ ID: "42", UF_CRM_LINK_ID: "plink_ABC" }));
  const rzp = createFakeRazorpay();
  rzp.addLink({ id: "plink_ABC", reference_id: "42", notes: { bitrix_deal_id: "42" }, order_id: "order_123" });
  const unresolvedLinks = new Map<string, string>();
  const deps = { bitrix: bitrix.client, razorpay: rzp.client, linkIdField: "UF_CRM_LINK_ID", unresolvedLinks, moveDealToWon: false };
  return { bitrix, rzp, unresolvedLinks, deps };
}

describe("resolveDealId", () => {
  const failedWith = (fields: Record<string, unknown>) => parse(webhookBody("payment.failed", { payment: paymentEntity(fields) }));

  it("prefers notes.bitrix_deal_id on the payment link, once the link checks out", async () => {
    const { deps } = webhookSetup();
    const webhook = parse(webhookBody("payment_link.paid", { payment_link: linkEntity({ reference_id: "99" }) }));
    expect(await resolveDealId(webhook, deps)).toEqual({ dealId: "42", source: "payment_link.notes" });
  });

  it.each([["54"], ["77-3"], ["INV-001"]])(
    "never matches by reference_id alone (a hand-made link with reference %s)",
    async (referenceId) => {
      // No bitrix_deal_id note means this link wasn't created by this service,
      // even if its reference happens to look like one of our deal IDs.
      const { deps } = webhookSetup();
      const webhook = parse(
        webhookBody("payment_link.paid", { payment_link: linkEntity({ notes: [], reference_id: referenceId }) }),
      );
      expect(await resolveDealId(webhook, deps)).toBeUndefined();
    },
  );

  it("ignores deal 42's note copied onto another link", async () => {
    // Razorpay signs the webhook, but anyone can write (or copy) notes.
    const { deps, bitrix } = webhookSetup();
    const webhook = parse(webhookBody("payment_link.paid", { payment_link: linkEntity({ id: "plink_Copy" }) }));
    expect(await resolveDealId(webhook, deps)).toBeUndefined();
    expect(bitrix.comments("42")).toEqual([]);
  });

  it("ignores deal 42's note copied onto an unrelated payment (e.g. a website's Checkout)", async () => {
    const { deps } = webhookSetup();
    expect(await resolveDealId(failedWith({ notes: { bitrix_deal_id: "42" }, order_id: "order_Web" }), deps)).toBeUndefined();
    expect(await resolveDealId(failedWith({ notes: { bitrix_deal_id: "42" }, order_id: null }), deps)).toBeUndefined();
  });

  it("accepts a link this service created but couldn't save to the deal", async () => {
    const { deps, bitrix, unresolvedLinks } = webhookSetup();
    bitrix.deals.set("42", deal({ ID: "42", UF_CRM_LINK_ID: "plink_Older" }));
    unresolvedLinks.set("42", "plink_ABC");
    const webhook = parse(webhookBody("payment_link.paid", { payment_link: linkEntity() }));
    expect(await resolveDealId(webhook, deps)).toEqual({ dealId: "42", source: "payment_link.notes" });
  });

  it("returns undefined when the deal can't be loaded to check the link", async () => {
    const { deps, bitrix } = webhookSetup();
    bitrix.deals.delete("42");
    const webhook = parse(webhookBody("payment_link.paid", { payment_link: linkEntity() }));
    expect(await resolveDealId(webhook, deps)).toBeUndefined();
  });

  it("uses the payment's notes for payment.failed, if its order is the deal link's order", async () => {
    const { deps } = webhookSetup();
    expect(await resolveDealId(failedWith({ notes: { bitrix_deal_id: "42" } }), deps)).toEqual({
      dealId: "42",
      source: "payment.notes",
    });
  });

  it("as a last resort, asks Razorpay for the order", async () => {
    const { deps, rzp } = webhookSetup();
    rzp.orders.set("order_123", { id: "order_123", receipt: null, notes: { bitrix_deal_id: "42" } });
    expect(await resolveDealId(failedWith({}), deps)).toEqual({ dealId: "42", source: "fetched order.notes" });
  });

  it("returns undefined for payments unrelated to our links (e.g. website checkout)", async () => {
    const { deps, rzp, bitrix } = webhookSetup();
    rzp.orders.set("order_123", { id: "order_123", receipt: "web-1", notes: [] });
    expect(await resolveDealId(failedWith({}), deps)).toBeUndefined();
    expect(bitrix.calls).toEqual([]); // no claim, so nothing to check
  });

  it("returns undefined (not an error) when the order lookup fails", async () => {
    const { deps, rzp } = webhookSetup();
    rzp.failOn("GET /orders/:id", () => json(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }));
    expect(await resolveDealId(failedWith({}), deps)).toBeUndefined();
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
    const { bitrix, deps } = webhookSetup();
    const outcome = await processWebhook(paid(), deps);
    expect(outcome).toEqual({ status: "done", dealId: "42", commented: true });
    expect(bitrix.comments("42")).toHaveLength(1);
    expect(bitrix.callsTo("crm.deal.update")).toHaveLength(0);
  });

  it("does nothing to the deal when the link isn't the deal's own", async () => {
    const { bitrix, deps } = webhookSetup();
    const copied = parse(
      webhookBody("payment_link.paid", { payment_link: linkEntity({ id: "plink_Copy", amount_paid: 149_999 }), payment: paymentEntity() }),
    );
    expect(await processWebhook(copied, { ...deps, moveDealToWon: true })).toEqual({ status: "no_deal" });
    expect(bitrix.comments("42")).toEqual([]);
    expect(bitrix.callsTo("crm.deal.update")).toHaveLength(0);
  });

  it("moves the deal to its pipeline's Won stage when enabled", async () => {
    const { bitrix, deps } = webhookSetup();
    bitrix.deals.set("42", deal({ ID: "42", CATEGORY_ID: "3", UF_CRM_LINK_ID: "plink_ABC" }));
    const outcome = await processWebhook(paid(), { ...deps, moveDealToWon: true });
    expect(outcome).toMatchObject({ status: "done", movedToWon: true });
    expect(bitrix.deals.get("42")?.STAGE_ID).toBe("C3:WON");
  });

  it("comments (instead of failing) when the move to Won is refused", async () => {
    const { bitrix, deps } = webhookSetup();
    bitrix.failOn("crm.deal.update", () => json(200, { error: "ACCESS_DENIED", error_description: "Access denied" }));
    const outcome = await processWebhook(paid(), { ...deps, moveDealToWon: true });
    expect(outcome).toMatchObject({ status: "done", commented: true, movedToWon: false });
    expect(bitrix.comments("42")[1]).toMatch(/could not be moved to Won automatically: .*ACCESS_DENIED/);
  });

  it("only moves to Won on payment_link.paid", async () => {
    const { bitrix, deps } = webhookSetup();
    const failed = parse(webhookBody("payment.failed", { payment: paymentEntity({ notes: { bitrix_deal_id: "42" } }) }));
    expect(await processWebhook(failed, { ...deps, moveDealToWon: true })).toMatchObject({ status: "done", dealId: "42" });
    expect(bitrix.callsTo("crm.deal.update")).toHaveLength(0);
  });

  it("ignores events it doesn't handle", async () => {
    const { bitrix, deps } = webhookSetup();
    const outcome = await processWebhook(parse(webhookBody("refund.created")), deps);
    expect(outcome.status).toBe("ignored");
    expect(bitrix.calls).toHaveLength(0);
  });

  it("skips payments that don't belong to any deal", async () => {
    const { deps } = webhookSetup();
    const outcome = await processWebhook(parse(webhookBody("payment.failed", { payment: paymentEntity({ order_id: null }) })), deps);
    expect(outcome).toEqual({ status: "no_deal" });
  });

  it("never throws, even when Bitrix is completely down", async () => {
    const { bitrix, deps } = webhookSetup();
    bitrix.failOn("crm.timeline.comment.add", () => new Response("<html>down</html>", { status: 503 }));
    await expect(processWebhook(paid(), deps)).resolves.toEqual({ status: "done", dealId: "42", commented: false });
  });
});

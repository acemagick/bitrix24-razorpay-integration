import { describe, expect, it } from "vitest";

import { RazorpayWebhookSchema, RequestValidationError, extractDealId, isHandledEvent } from "../src/models.ts";
import { linkEntity, paymentEntity, webhookBody } from "./helpers.ts";

describe("extractDealId", () => {
  it.each([
    ["query string (automation robot)", { deal_id: "42" }, undefined],
    ["JSON body", {}, { deal_id: 42 }],
    ["JSON body, camelCase with spaces", {}, { dealId: " 42 " }],
    ["form body as array (urlencoded extended: true)", {}, { document_id: ["crm", "CCrmDocumentDeal", "DEAL_42"] }],
    ["form body as flat key (urlencoded extended: false)", {}, { "document_id[2]": "DEAL_42" }],
  ])("reads the deal ID from the %s", (_label, query, body) => {
    expect(extractDealId(query, body)).toBe("42");
  });

  it("prefers the query string over the body", () => {
    expect(extractDealId({ deal_id: "1" }, { deal_id: "2" })).toBe("1");
  });

  it.each([
    ["missing", {}, {}],
    ["not a number", { deal_id: "abc" }, undefined],
    ["an injection attempt", { deal_id: "1;DROP TABLE" }, undefined],
  ])("rejects a deal ID that is %s", (_label, query, body) => {
    expect(() => extractDealId(query, body)).toThrow(RequestValidationError);
  });
});

describe("RazorpayWebhookSchema", () => {
  it('turns Razorpay\'s empty notes "[]" into an empty object', () => {
    const parsed = RazorpayWebhookSchema.parse(
      JSON.parse(webhookBody("payment.failed", { payment: paymentEntity({ notes: [] }) })),
    );
    expect(parsed.payload.payment?.entity.notes).toEqual({});
  });

  it("keeps fields it doesn't know about, so new Razorpay fields don't break parsing", () => {
    const parsed = RazorpayWebhookSchema.parse(
      JSON.parse(webhookBody("payment_link.paid", { payment_link: linkEntity({ some_new_field: 1 }) })),
    );
    expect((parsed.payload.payment_link?.entity as Record<string, unknown>).some_new_field).toBe(1);
  });

  it("accepts an event with no payload", () => {
    expect(RazorpayWebhookSchema.parse({ event: "refund.created" }).payload).toEqual({});
  });
});

describe("isHandledEvent", () => {
  it("knows the five events we act on", () => {
    for (const event of [
      "payment_link.paid",
      "payment_link.partially_paid",
      "payment_link.expired",
      "payment_link.cancelled",
      "payment.failed",
    ]) {
      expect(isHandledEvent(event)).toBe(true);
    }
    expect(isHandledEvent("refund.created")).toBe(false);
  });
});

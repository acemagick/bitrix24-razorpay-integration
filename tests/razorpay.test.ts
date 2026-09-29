import Big from "big.js";
import { describe, expect, it } from "vitest";

import {
  DuplicateReferenceError,
  InvalidAmountError,
  RazorpayApiError,
  RazorpayClient,
  RazorpayUnavailableError,
  buildPaymentLinkPayload,
  formatMoney,
  toPaise,
  type CreatePaymentLinkInput,
} from "../src/razorpay.ts";
import { createFakeRazorpay, json } from "./helpers.ts";

const input = (overrides: Partial<CreatePaymentLinkInput> = {}): CreatePaymentLinkInput => ({
  amount: new Big("11.80"),
  currency: "INR",
  description: "Website redesign",
  dealId: "54",
  ...overrides,
});

describe("toPaise", () => {
  it.each([
    ["1499.99", 149_999],
    ["11.80000000", 1180],
    ["1.005", 101], // plain JS: 1.005 * 100 = 100.49999999999999, which would round to 100
    ["1499.995", 150_000], // rounds half up
    ["0.1", 10],
  ])("converts %s rupees to %i paise exactly", (rupees, paise) => {
    expect(toPaise(new Big(rupees))).toBe(paise);
  });

  it.each([["0"], ["-5"], ["0.004"]])("rejects %s", (rupees) => {
    expect(() => toPaise(new Big(rupees))).toThrow(InvalidAmountError);
  });
});

describe("formatMoney", () => {
  it("formats paise for humans", () => {
    expect(formatMoney(149_999, "INR")).toBe("₹1,499.99");
    expect(formatMoney(150_000, "USD")).toBe("$1,500.00");
  });

  it("prints an unknown but well-formed currency code as-is", () => {
    // Intl separates code and number with a NON-BREAKING space (U+00A0), hence \s.
    expect(formatMoney(1234, "XYZ")).toMatch(/^XYZ\s12\.34$/);
  });

  it("falls back to plain text for a malformed currency code instead of throwing", () => {
    expect(formatMoney(1234, "RUPEE")).toBe("RUPEE 12.34");
  });
});

describe("buildPaymentLinkPayload", () => {
  it("builds the request body Razorpay expects", () => {
    expect(buildPaymentLinkPayload(input(), "54")).toEqual({
      amount: 1180,
      currency: "INR",
      description: "Website redesign",
      reference_id: "54",
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { bitrix_deal_id: "54" },
      accept_partial: false,
    });
  });

  it("leaves out empty customer fields and cleans up the phone number", () => {
    const payload = buildPaymentLinkPayload(
      input({ customer: { name: "Asha Rao", email: "", phone: "+91 (98765) 43-210" } }),
      "54",
    );
    expect(payload.customer).toEqual({ name: "Asha Rao", contact: "+919876543210" });
  });

  it("omits the customer entirely when there's nothing to send", () => {
    expect(buildPaymentLinkPayload(input({ customer: { name: "", email: "" } }), "54")).not.toHaveProperty("customer");
  });

  it("sets expire_by in Unix SECONDS", () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = buildPaymentLinkPayload(input({ expireInDays: 7 }), "54");
    expect(payload.expire_by).toBeGreaterThanOrEqual(before + 7 * 86_400);
    expect(payload.expire_by).toBeLessThan(before + 7 * 86_400 + 5);
  });

  it("makes a link that never expires when no expiry is given (recurring links)", () => {
    expect(buildPaymentLinkPayload(input(), "66-2026")).not.toHaveProperty("expire_by");
  });

  it("adds extra notes next to the deal ID", () => {
    const payload = buildPaymentLinkPayload(input({ extraNotes: { subscription_year: "2026" } }), "54-2026");
    expect(payload.notes).toEqual({ subscription_year: "2026", bitrix_deal_id: "54" });
  });

  it("never lets extra notes replace the deal ID (payments are matched by it)", () => {
    const payload = buildPaymentLinkPayload(input({ extraNotes: { bitrix_deal_id: "999" } }), "54");
    expect(payload.notes).toEqual({ bitrix_deal_id: "54" });
  });
});

describe("RazorpayClient errors", () => {
  const clientAnswering = (response: () => Response) =>
    new RazorpayClient("rzp_test_abc123", "key-secret", { fetchFn: async () => response() });

  it("flags a 401 as an authentication error", async () => {
    const client = clientAnswering(() =>
      json(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }),
    );
    const error = await client.verifyCredentials().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RazorpayApiError);
    expect((error as RazorpayApiError).isAuthError).toBe(true);
  });

  it("keeps Razorpay's human-readable description and the field it names", async () => {
    const client = clientAnswering(() =>
      json(400, { error: { code: "BAD_REQUEST_ERROR", description: "Please enter a valid email", field: "customer.email" } }),
    );
    await expect(client.createPaymentLink(input(), "54")).rejects.toMatchObject({
      description: "Please enter a valid email",
      field: "customer.email",
    });
  });

  it("recognises a reused reference_id", async () => {
    const client = clientAnswering(() =>
      json(400, { error: { code: "BAD_REQUEST_ERROR", description: "Payment Link with reference id 54 already exists" } }),
    );
    await expect(client.createPaymentLink(input(), "54")).rejects.toBeInstanceOf(DuplicateReferenceError);
  });

  it("reports a network failure as unavailable, without retrying", async () => {
    let calls = 0;
    const client = new RazorpayClient("rzp_test_abc123", "key-secret", {
      fetchFn: async () => {
        calls++;
        throw new TypeError("fetch failed");
      },
    });
    await expect(client.createPaymentLink(input(), "54")).rejects.toBeInstanceOf(RazorpayUnavailableError);
    expect(calls).toBe(1); // creating a link must never be blindly retried
  });

  it("sends HTTP Basic auth built from the key id and secret", async () => {
    let auth = "";
    const client = new RazorpayClient("rzp_test_abc123", "key-secret", {
      fetchFn: async (_url, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return json(200, { items: [] });
      },
    });
    await client.verifyCredentials();
    expect(auth).toBe(`Basic ${Buffer.from("rzp_test_abc123:key-secret").toString("base64")}`);
  });
});

describe("createPaymentLinkForDeal", () => {
  it('uses the deal ID as reference_id, then "-2", "-3" while those are taken', async () => {
    const rzp = createFakeRazorpay();
    rzp.addLink({ id: "plink_A", reference_id: "54" });
    rzp.addLink({ id: "plink_B", reference_id: "54-2" });

    const link = await rzp.client.createPaymentLinkForDeal(input());
    expect(link.reference_id).toBe("54-3");
    expect(rzp.calls.filter((c) => c === "POST /payment_links")).toHaveLength(3);
  });

  it("can reuse the reference of a cancelled link", async () => {
    const rzp = createFakeRazorpay();
    rzp.addLink({ id: "plink_A", reference_id: "54", status: "cancelled" });
    expect((await rzp.client.createPaymentLinkForDeal(input())).reference_id).toBe("54");
  });

  it("does not retry other errors", async () => {
    const rzp = createFakeRazorpay();
    rzp.failOn("POST /payment_links", () =>
      json(400, { error: { code: "BAD_REQUEST_ERROR", description: "The amount must be atleast INR 1.00", field: "amount" } }),
    );
    await expect(rzp.client.createPaymentLinkForDeal(input())).rejects.toMatchObject({ field: "amount" });
    expect(rzp.calls).toEqual(["POST /payment_links"]);
  });

  it("starts from referenceBase when given (recurring: <dealId>-<year>), with the same -2 suffix retry", async () => {
    const rzp = createFakeRazorpay();
    rzp.addLink({ id: "plink_A", reference_id: "66-2026" }); // e.g. a link someone made by hand

    const link = await rzp.client.createPaymentLinkForDeal(
      input({ dealId: "66", referenceBase: "66-2026", extraNotes: { subscription_year: "2026" } }),
    );

    expect(link.reference_id).toBe("66-2026-2");
    expect(link.notes).toEqual({ subscription_year: "2026", bitrix_deal_id: "66" });
  });

  it("still uses the plain deal ID when no referenceBase is given (Deals pipeline unchanged)", async () => {
    const rzp = createFakeRazorpay();
    const link = await rzp.client.createPaymentLinkForDeal(input());
    expect(link.reference_id).toBe("54");
    // The exact request body the Deals pipeline has always sent.
    expect(rzp.created()[0]?.request).toEqual(buildPaymentLinkPayload(input(), "54"));
    expect(rzp.created()[0]?.request).toMatchObject({ notes: { bitrix_deal_id: "54" }, reference_id: "54" });
    expect(link.notes).toEqual({ bitrix_deal_id: "54" });
  });
});

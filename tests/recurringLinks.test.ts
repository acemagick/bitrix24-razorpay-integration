/**
 * The Recurring pipeline's yearly renewal links (src/recurringLinks.ts).
 *
 * A fake clock lets these tests do what can't be tried for real without
 * waiting: move a year ahead and check that a new yearly link is made.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { RenewalReminder } from "../src/models.ts";
import { FlowError, UnresolvedLinkStore } from "../src/paymentLinks.ts";
import { isRenewalReminder, sendRenewalReminder } from "../src/recurringLinks.ts";
import { createFakeBitrix, createFakeRazorpay, deal, json, makeTempDir, testConfig } from "./helpers.ts";

const DAY = 24 * 60 * 60;
const JAN_15_2026 = Date.UTC(2026, 0, 15) / 1000; // Unix seconds

/** Deal 66 in the Recurring pipeline (ID 6), worth ₹999, and a clock set to 15 Jan 2026. */
async function setup(env: Record<string, string> = { RECURRING_CATEGORY_ID: "6" }) {
  const bitrix = createFakeBitrix();
  const rzp = createFakeRazorpay();
  bitrix.deals.set("66", deal({ ID: "66", TITLE: "Annual plan", CATEGORY_ID: "6", OPPORTUNITY: "999.00000000" }));

  const clock = { seconds: JAN_15_2026 };
  rzp.nowSeconds = clock.seconds;
  const unresolvedLinks = new UnresolvedLinkStore(join(await makeTempDir(), "unresolved.json"));
  const deps = {
    config: testConfig(env),
    bitrix: bitrix.client,
    razorpay: rzp.client,
    unresolvedLinks,
    now: () => clock.seconds * 1000,
  };

  const remind = (days: RenewalReminder, dealId = "66") => sendRenewalReminder(dealId, days, deps);
  const remindExpectingError = async (days: RenewalReminder): Promise<FlowError> => {
    const error = await remind(days).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FlowError);
    return error as FlowError;
  };
  /** Move the clock (and the fake Razorpay's clock) forward. */
  const advanceDays = (days: number) => {
    clock.seconds += days * DAY;
    rzp.nowSeconds = clock.seconds;
  };
  /** The customer pays a link in full. */
  const pay = (linkId: string) => {
    const link = rzp.links.get(linkId)!;
    Object.assign(link, { status: "paid", amount_paid: link.amount });
  };
  const dealFields = () => bitrix.deals.get("66")!;

  return { bitrix, rzp, unresolvedLinks, remind, remindExpectingError, advanceDays, pay, dealFields };
}

// --------------------------------------------------------------------------- one link per year

describe("one link per year, used by all three reminders", () => {
  it("the first reminder creates this year's link, with the Recurring deal's own amount", async () => {
    const { remind, rzp, bitrix, dealFields } = await setup();

    const result = await remind(30);

    expect(result).toMatchObject({
      status: "created",
      deal_id: "66",
      days_left: 30,
      reference_id: "66-2026", // the customer's RECEIPT: deal + year
      amount: 99_900,
      amount_display: "₹999.00",
    });
    const request = rzp.created()[0]?.request;
    expect(request).toMatchObject({
      amount: 99_900,
      description: "Annual plan: renewal 2026",
      notes: { subscription_year: "2026", pipeline: "recurring", bitrix_deal_id: "66" },
    });
    expect(request).not.toHaveProperty("expire_by"); // valid until paid
    expect(dealFields()).toMatchObject({ UF_CRM_LINK: result.short_url, UF_CRM_LINK_ID: result.payment_link_id });
    expect(bitrix.comments("66")[0]).toMatch(/^Razorpay: Renewal payment link created \(2026\)\nReminder: 1 month left/);
  });

  it("names the link after the renewal's year, even when the reminder is in the year before", async () => {
    const { remind, rzp, bitrix, advanceDays } = await setup();
    advanceDays(334); // 15 Dec 2026: the 1-month reminder for a renewal on 14 Jan 2027

    const result = await remind(30);

    expect(result.reference_id).toBe("66-2027");
    expect(rzp.created()[0]?.request).toMatchObject({
      description: "Annual plan: renewal 2027",
      notes: { subscription_year: "2027" },
    });
    expect(bitrix.comments("66")[0]).toMatch(/^Razorpay: Renewal payment link created \(2027\)/);
  });

  it("the 15-day and 5-day reminders reuse the SAME link while it's unpaid", async () => {
    const { remind, rzp, bitrix, advanceDays } = await setup();
    const first = await remind(30);

    advanceDays(15);
    const second = await remind(15);
    advanceDays(10);
    const third = await remind(5);

    expect(second).toMatchObject({ status: "reminded", payment_link_id: first.payment_link_id, days_left: 15 });
    expect(third).toMatchObject({ status: "reminded", payment_link_id: first.payment_link_id, days_left: 5 });
    expect(rzp.created()).toHaveLength(1); // no second link in Razorpay
    expect(bitrix.comments("66")[1]).toContain("Renewal reminder (15 days left)");
    expect(bitrix.comments("66")[1]).toContain(`Link: ${first.short_url}`);
    expect(bitrix.comments("66")[2]).toContain("Renewal reminder (5 days left)");
  });

  it("once this year's link is paid, a reminder says so and creates nothing", async () => {
    const { remind, rzp, bitrix, pay, advanceDays } = await setup();
    const first = await remind(30);
    pay(first.payment_link_id);

    advanceDays(15);
    const result = await remind(15);

    expect(result).toMatchObject({ status: "already_paid", payment_link_id: first.payment_link_id });
    expect(rzp.created()).toHaveLength(1);
    expect(bitrix.comments("66")[1]).toContain("This year's renewal is already paid (₹999.00)");
  });

  it("if this year's link was cancelled by hand, a new one is made for this year", async () => {
    const { remind, rzp, advanceDays } = await setup();
    const first = await remind(30);
    rzp.links.get(first.payment_link_id)!.status = "cancelled";

    advanceDays(15);
    const result = await remind(15);

    expect(result.status).toBe("created");
    expect(result.payment_link_id).not.toBe(first.payment_link_id);
    expect(result.reference_id).toBe("66-2026"); // a cancelled link frees its reference
  });
});

// --------------------------------------------------------------------------- next year

describe("every new year gets a new link", () => {
  it("after last year's link was paid, next year's first reminder creates a new link", async () => {
    const { remind, rzp, pay, advanceDays } = await setup();
    const lastYear = await remind(30);
    pay(lastYear.payment_link_id);

    advanceDays(365);
    const thisYear = await remind(30);

    expect(thisYear).toMatchObject({ status: "created", reference_id: "66-2027" });
    expect(thisYear.payment_link_id).not.toBe(lastYear.payment_link_id);
    expect(thisYear.cancelled_previous_link_id).toBeUndefined();
    expect(rzp.links.get(lastYear.payment_link_id)?.status).toBe("paid"); // untouched
    expect(rzp.created()[1]?.request?.notes).toMatchObject({ subscription_year: "2027" });
  });

  it("if last year's link was never paid, it's cancelled before this year's is made", async () => {
    const { remind, rzp, bitrix, advanceDays } = await setup();
    const lastYear = await remind(30);

    advanceDays(365);
    const thisYear = await remind(30);

    expect(rzp.links.get(lastYear.payment_link_id)?.status).toBe("cancelled");
    expect(thisYear).toMatchObject({ status: "created", cancelled_previous_link_id: lastYear.payment_link_id });
    expect(bitrix.comments("66").at(-1)).toContain("Last year's unpaid link");
  });

  it.each([
    [170, "reminded"], // under ~6 months: still this year's link
    [200, "created"], // over ~6 months: last year's, so a new one
  ])("a link %i days old counts as %s", async (days, status) => {
    const { remind, advanceDays } = await setup();
    await remind(30);
    advanceDays(days);
    expect((await remind(30)).status).toBe(status);
  });
});

// --------------------------------------------------------------------------- safety

describe("safety checks", () => {
  it("refuses deals outside the Recurring pipeline, and says so on the deal", async () => {
    const { remindExpectingError, rzp, bitrix, dealFields } = await setup();
    dealFields().CATEGORY_ID = "0"; // a Deals-pipeline deal

    const error = await remindExpectingError(30);

    expect(error).toMatchObject({ httpStatus: 422, code: "NOT_RECURRING_DEAL" });
    expect(rzp.calls).toEqual([]);
    expect(bitrix.comments("66")[0]).toContain("isn't in the Recurring pipeline");
  });

  it("is switched off when RECURRING_CATEGORY_ID isn't set", async () => {
    const { remindExpectingError, rzp } = await setup({});
    expect(await remindExpectingError(30)).toMatchObject({ httpStatus: 404, code: "NOT_FOUND" });
    expect(rzp.calls).toEqual([]);
  });

  it("needs an amount to create a link, but not to repeat an existing one", async () => {
    const { remind, remindExpectingError, advanceDays, dealFields } = await setup();
    await remind(30);
    dealFields().OPPORTUNITY = "";
    advanceDays(15);
    expect((await remind(15)).status).toBe("reminded");

    advanceDays(365);
    expect(await remindExpectingError(30)).toMatchObject({ code: "INVALID_AMOUNT" });
  });

  it("ignores text typed into the Link ID field by hand", async () => {
    const { remind, rzp, dealFields } = await setup();
    dealFields().UF_CRM_LINK_ID = "sent on WhatsApp";
    expect((await remind(30)).status).toBe("created");
    expect(rzp.calls).toEqual(["POST /payment_links"]);
  });

  it("stops (no new link) when the current link can't be checked", async () => {
    const { remind, remindExpectingError, rzp, advanceDays } = await setup();
    await remind(30);
    rzp.failOn("GET /payment_links/:id", () => {
      throw new TypeError("fetch failed");
    });
    advanceDays(15);
    expect(await remindExpectingError(15)).toMatchObject({ code: "RAZORPAY_UNAVAILABLE" });
    expect(rzp.created()).toHaveLength(1);
  });

  it("stops (no new link) when last year's unpaid link can't be cancelled", async () => {
    const { remind, remindExpectingError, rzp, advanceDays } = await setup();
    await remind(30);
    rzp.failOn("POST /payment_links/:id/cancel", () =>
      json(400, { error: { code: "BAD_REQUEST_ERROR", description: "Payment link cannot be cancelled as it is paid" } }),
    );
    advanceDays(365);
    const error = await remindExpectingError(30);
    expect(error.message).toContain("Could not cancel last year's unpaid renewal link");
    expect(rzp.created()).toHaveLength(1);
  });

  it("cancels the new link if it can't be saved to the deal", async () => {
    const { remindExpectingError, rzp, bitrix } = await setup();
    bitrix.failOn("crm.deal.update", () => json(400, { error: "ERROR_CORE", error_description: "Field Investment Readiness is required" }));

    const error = await remindExpectingError(30);

    expect(error.code).toBe("BITRIX_ERROR");
    expect(error.message).toContain("so it was cancelled");
    expect(rzp.created()[0]?.status).toBe("cancelled");
  });

  it("cancels an earlier link that was never saved to the deal, then makes this year's", async () => {
    const { remind, rzp, unresolvedLinks } = await setup();
    rzp.addLink({ id: "plink_Orphan", reference_id: "66-2026-old", notes: { bitrix_deal_id: "66" } });
    await unresolvedLinks.set("66", "plink_Orphan");

    const result = await remind(30);

    expect(rzp.links.get("plink_Orphan")?.status).toBe("cancelled");
    expect(result.status).toBe("created");
    expect(await unresolvedLinks.get("66")).toBeUndefined();
  });

  it("treats a never-saved link that the customer PAID this year as this year's payment", async () => {
    const { remind, rzp, unresolvedLinks, dealFields } = await setup();
    rzp.addLink({ id: "plink_Orphan", status: "paid", amount: 99_900, amount_paid: 99_900, reference_id: "66-2026" });
    await unresolvedLinks.set("66", "plink_Orphan");

    const result = await remind(15);

    expect(result).toMatchObject({ status: "already_paid", payment_link_id: "plink_Orphan" });
    expect(dealFields().UF_CRM_LINK_ID).toBe("plink_Orphan"); // now saved on the deal
    expect(rzp.created()).toHaveLength(0);
    expect(await unresolvedLinks.get("66")).toBeUndefined();
  });

  it("refuses a second reminder for the same deal while one is running", async () => {
    const { remind, rzp } = await setup();
    rzp.latencyMs = 30;
    const [first, second] = await Promise.allSettled([remind(30), remind(30)]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: { code: "ALREADY_IN_PROGRESS" } });
    expect(rzp.created()).toHaveLength(1);
  });
});

describe("isRenewalReminder", () => {
  it("accepts exactly the three reminders", () => {
    expect([30, 15, 5].every(isRenewalReminder)).toBe(true);
    expect([0, 7, 10, 31].some(isRenewalReminder)).toBe(false);
  });
});

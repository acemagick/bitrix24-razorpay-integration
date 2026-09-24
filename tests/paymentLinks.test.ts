import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FlowError, UnresolvedLinkStore, createPaymentLinkForDeal } from "../src/paymentLinks.ts";
import { createFakeBitrix, createFakeRazorpay, deal, json, makeTempDir, testConfig } from "./helpers.ts";

/**
 * A deal 54 worth ₹11.80 with a contact, in a fake Bitrix, plus an empty fake
 * Razorpay account. Returns helpers to run the flow against them.
 */
async function setup() {
  const bitrix = createFakeBitrix();
  const rzp = createFakeRazorpay();
  bitrix.deals.set("54", deal({ CONTACT_ID: "9" }));
  bitrix.contacts.set("9", {
    NAME: "Asha",
    LAST_NAME: "Rao",
    EMAIL: [{ VALUE: "asha@example.com" }],
    PHONE: [{ VALUE: "+91 98765 43210" }],
  });
  const storePath = join(await makeTempDir(), "unresolved_links.json");
  const unresolvedLinks = new UnresolvedLinkStore(storePath);
  const deps = { config: testConfig(), bitrix: bitrix.client, razorpay: rzp.client, unresolvedLinks };

  const run = (dealId = "54") => createPaymentLinkForDeal(dealId, deps);
  /** Run the flow and return the FlowError it throws (fails the test if it succeeds). */
  const runExpectingError = async (dealId = "54"): Promise<FlowError> => {
    const error = await run(dealId).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FlowError);
    return error as FlowError;
  };
  const dealFields = () => bitrix.deals.get("54")!;

  return { bitrix, rzp, unresolvedLinks, storePath, run, runExpectingError, dealFields };
}

const RAZORPAY_EMAIL_ERROR = () =>
  json(400, { error: { code: "BAD_REQUEST_ERROR", description: "Please enter a valid email", field: "customer.email" } });

// --------------------------------------------------------------------------- happy path

describe("creating a link", () => {
  it("creates the link, saves it on the deal and comments", async () => {
    const { run, rzp, bitrix, dealFields } = await setup();

    const result = await run();

    expect(result).toEqual({
      status: "created",
      deal_id: "54",
      payment_link_id: "plink_Fake1",
      short_url: "https://rzp.io/rzp/fake1",
      reference_id: "54",
      amount: 1180,
      amount_display: "₹11.80",
      currency: "INR",
      deal_updated: true,
    });
    expect(rzp.created()[0]?.request).toMatchObject({
      amount: 1180,
      reference_id: "54",
      notes: { bitrix_deal_id: "54" },
      notify: { sms: false, email: false },
      customer: { name: "Asha Rao", email: "asha@example.com", contact: "+919876543210" },
    });
    expect(dealFields()).toMatchObject({ UF_CRM_LINK: "https://rzp.io/rzp/fake1", UF_CRM_LINK_ID: "plink_Fake1" });
    expect(bitrix.comments("54")).toEqual([
      "Razorpay: Payment link created\nAmount: ₹11.80\nLink: https://rzp.io/rzp/fake1\nLink ID: plink_Fake1",
    ]);
  });

  it("refuses a second request for the same deal while the first is still running", async () => {
    const { run, rzp } = await setup();
    rzp.latencyMs = 30; // make the two requests overlap

    const [first, second] = await Promise.allSettled([run(), run()]);

    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: { httpStatus: 409, code: "ALREADY_IN_PROGRESS" } });
    expect(rzp.created()).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------- failures

describe("every failure is reported on the deal", () => {
  it.each([
    ["no amount", ""],
    ["a zero amount", "0.00000000"],
    ["a negative amount", "-5"],
  ])("rejects a deal with %s, without calling Razorpay", async (_label, opportunity) => {
    const { runExpectingError, rzp, bitrix, dealFields } = await setup();
    dealFields().OPPORTUNITY = opportunity;

    const error = await runExpectingError();

    expect(error).toMatchObject({ httpStatus: 422, code: "INVALID_AMOUNT" });
    expect(rzp.calls).toEqual([]);
    expect(bitrix.comments("54")[0]).toMatch(/^Razorpay: Could not create payment link\n.*Amount/);
  });

  it("returns 404 for a missing deal, and doesn't try to comment on it", async () => {
    const { runExpectingError, bitrix, rzp } = await setup();
    const error = await runExpectingError("999");
    expect(error).toMatchObject({ httpStatus: 404, code: "DEAL_NOT_FOUND" });
    expect(bitrix.comments()).toEqual([]);
    expect(rzp.calls).toEqual([]);
  });

  it("returns 503 when Bitrix can't be reached", async () => {
    const { runExpectingError, bitrix } = await setup();
    bitrix.failOn("crm.deal.get", () => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await runExpectingError()).toMatchObject({ httpStatus: 503, code: "BITRIX_UNAVAILABLE" });
  });

  it("passes on Razorpay's reason, with a hint about the contact", async () => {
    const { runExpectingError, rzp, bitrix } = await setup();
    rzp.failOn("POST /payment_links", RAZORPAY_EMAIL_ERROR);

    const error = await runExpectingError();

    expect(error).toMatchObject({ httpStatus: 502, code: "RAZORPAY_REJECTED" });
    expect(bitrix.comments("54")[0]).toContain("Razorpay rejected the request: Please enter a valid email");
    expect(bitrix.comments("54")[0]).toContain("Check the email and phone number on the deal's contact.");
  });

  it("says the API keys are wrong on a 401", async () => {
    const { runExpectingError, rzp, bitrix } = await setup();
    rzp.failOn("POST /payment_links", () =>
      json(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } }),
    );
    await runExpectingError();
    expect(bitrix.comments("54")[0]).toContain("API keys configured in the integration are wrong");
  });

  it("warns that a link may exist when Razorpay doesn't answer", async () => {
    const { runExpectingError, rzp, bitrix } = await setup();
    rzp.failOn("POST /payment_links", () => {
      throw new TypeError("fetch failed");
    });
    expect(await runExpectingError()).toMatchObject({ code: "RAZORPAY_UNAVAILABLE" });
    expect(bitrix.comments("54")[0]).toContain("A link may still have been created");
  });
});

// --------------------------------------------------------------------------- previous link

describe("the deal's previous link", () => {
  /** Put a link into the fake Razorpay AND into the deal's Link ID field. */
  async function withPreviousLink(status: string, amountPaid = 0) {
    const ctx = await setup();
    ctx.rzp.addLink({ id: "plink_Old", status, amount_paid: amountPaid, reference_id: "54" });
    ctx.dealFields().UF_CRM_LINK_ID = "plink_Old";
    return ctx;
  }

  it("cancels an unpaid previous link before creating the new one", async () => {
    const { run, rzp, bitrix } = await withPreviousLink("created");

    const result = await run();

    expect(rzp.calls.slice(0, 3)).toEqual([
      "GET /payment_links/plink_Old",
      "POST /payment_links/plink_Old/cancel",
      "POST /payment_links",
    ]);
    expect(rzp.links.get("plink_Old")?.status).toBe("cancelled");
    expect(result.cancelled_previous_link_id).toBe("plink_Old");
    expect(result.reference_id).toBe("54"); // the cancelled link freed up "54"
    expect(bitrix.comments("54")[0]).toContain("The previous link (plink_Old) was cancelled");
  });

  it.each([
    ["paid", 1180, "₹11.80 of ₹11.80"],
    ["partially_paid", 500, "₹5.00 of ₹11.80"],
  ])("refuses a new link when the previous one is %s", async (status, paid, amounts) => {
    const { runExpectingError, rzp, bitrix } = await withPreviousLink(status, paid);

    const error = await runExpectingError();

    expect(error).toMatchObject({ httpStatus: 409, code: "ALREADY_PAID" });
    expect(rzp.calls).toEqual(["GET /payment_links/plink_Old"]); // checked, nothing created or cancelled
    expect(bitrix.comments("54")[0]).toContain(`already paid ${amounts}`);
    expect(bitrix.comments("54")[0]).toContain("clear the deal's Razorpay Link ID field (UF_CRM_LINK_ID)");
  });

  it.each([["expired"], ["cancelled"]])("just creates a new link when the previous one is %s", async (status) => {
    const { run, rzp } = await withPreviousLink(status);
    const result = await run();
    expect(result.cancelled_previous_link_id).toBeUndefined();
    expect(rzp.calls).not.toContain("POST /payment_links/plink_Old/cancel");
  });

  it("ignores a previous link ID that Razorpay doesn't know", async () => {
    const { run, dealFields } = await setup();
    dealFields().UF_CRM_LINK_ID = "plink_FromAnotherAccount";
    await expect(run()).resolves.toMatchObject({ status: "created" });
  });

  it("ignores text typed into the field by hand, without asking Razorpay", async () => {
    const { run, rzp, dealFields } = await setup();
    dealFields().UF_CRM_LINK_ID = "sent on WhatsApp";
    await run();
    expect(rzp.calls).toEqual(["POST /payment_links"]);
  });

  it("stops when the previous link can't be cancelled", async () => {
    const { runExpectingError, rzp } = await withPreviousLink("created");
    rzp.failOn("POST /payment_links/:id/cancel", () =>
      json(400, { error: { code: "BAD_REQUEST_ERROR", description: "Payment link cannot be cancelled as it is paid" } }),
    );

    const error = await runExpectingError();

    expect(error).toMatchObject({ code: "RAZORPAY_REJECTED" });
    expect(error.message).toContain("No new link was created");
    expect(rzp.created()).toHaveLength(0);
  });

  it("stops when Razorpay can't be reached to check the previous link", async () => {
    const { runExpectingError, rzp } = await withPreviousLink("created");
    rzp.failOn("GET /payment_links/:id", () => {
      throw new TypeError("fetch failed");
    });
    expect(await runExpectingError()).toMatchObject({ code: "RAZORPAY_UNAVAILABLE" });
    expect(rzp.created()).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------- saving to the deal fails

describe("when the new link can't be saved to the deal", () => {
  const REQUIRED_FIELD_ERROR = () => json(400, { error: "ERROR_CORE", error_description: "Field Purpose is required" });

  it("cancels the new link so it can't be paid", async () => {
    const { runExpectingError, rzp, bitrix } = await setup();
    bitrix.failOn("crm.deal.update", REQUIRED_FIELD_ERROR);

    const error = await runExpectingError();

    expect(error).toMatchObject({ code: "BITRIX_ERROR" });
    expect(error.message).toContain("could not be saved to the deal, so it was cancelled");
    expect(rzp.links.get("plink_Fake1")?.status).toBe("cancelled");
  });

  describe("and cancelling it fails too", () => {
    async function leaveUnresolvedLink() {
      const ctx = await setup();
      ctx.bitrix.failOn("crm.deal.update", REQUIRED_FIELD_ERROR);
      ctx.rzp.failOn("POST /payment_links/:id/cancel", () => new Response("<html>502</html>", { status: 502 }));
      const error = await ctx.runExpectingError();
      ctx.bitrix.clearFailures();
      ctx.rzp.clearFailures();
      return { ...ctx, error };
    }

    it("warns that the link is still payable and records it on disk", async () => {
      const { error, rzp, storePath, unresolvedLinks } = await leaveUnresolvedLink();

      expect(error.message).toContain("STILL PAYABLE");
      expect(rzp.links.get("plink_Fake1")?.status).toBe("created");
      expect(unresolvedLinks.get("54")).toBe("plink_Fake1");
      expect(JSON.parse(await readFile(storePath, "utf8"))).toEqual([["54", "plink_Fake1"]]);
    });

    it("cancels that link first on the next request, then creates a new one", async () => {
      const { run, rzp, unresolvedLinks } = await leaveUnresolvedLink();

      const result = await run();

      expect(rzp.links.get("plink_Fake1")?.status).toBe("cancelled");
      expect(result.payment_link_id).toBe("plink_Fake2");
      expect(unresolvedLinks.get("54")).toBeUndefined();
    });

    it("refuses a new link if the customer paid that unsaved link", async () => {
      const { runExpectingError, rzp, unresolvedLinks } = await leaveUnresolvedLink();
      Object.assign(rzp.links.get("plink_Fake1")!, { status: "paid", amount_paid: 1180 });

      const error = await runExpectingError();

      expect(error).toMatchObject({ code: "ALREADY_PAID" });
      expect(error.message).toContain("This link was never saved to the deal");
      expect(unresolvedLinks.get("54")).toBe("plink_Fake1"); // still blocking
    });

    it("hands the link over to the deal field once the team enters its ID there", async () => {
      const { runExpectingError, rzp, unresolvedLinks, dealFields } = await leaveUnresolvedLink();
      Object.assign(rzp.links.get("plink_Fake1")!, { status: "paid", amount_paid: 1180 });
      dealFields().UF_CRM_LINK_ID = "plink_Fake1";

      const error = await runExpectingError();

      // Same refusal, now via the normal field check, and the record is cleared.
      expect(error).toMatchObject({ code: "ALREADY_PAID" });
      expect(error.message).toContain("clear the deal's Razorpay Link ID field");
      expect(unresolvedLinks.get("54")).toBeUndefined();
    });
  });
});

// --------------------------------------------------------------------------- the store itself

describe("UnresolvedLinkStore", () => {
  it("survives a restart", async () => {
    const path = join(await makeTempDir(), "unresolved.json");
    await new UnresolvedLinkStore(path).set("54", "plink_A");

    const reloaded = new UnresolvedLinkStore(path);
    await reloaded.load();
    expect(reloaded.get("54")).toBe("plink_A");

    await reloaded.delete("54");
    const again = new UnresolvedLinkStore(path);
    await again.load();
    expect(again.get("54")).toBeUndefined();
  });

  it("refuses to start from a corrupt file, rather than forget a payable link", async () => {
    const path = join(await makeTempDir(), "unresolved.json");
    await writeFile(path, "{ not json");
    await expect(new UnresolvedLinkStore(path).load()).rejects.toThrow();
  });
});

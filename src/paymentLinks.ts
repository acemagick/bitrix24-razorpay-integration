/**
 * Flow 1: create a Razorpay payment link for a Bitrix24 deal.
 *
 *   1. Load the deal (amount, currency, title) and its contact from Bitrix24.
 *   2. Check the amount is usable.
 *   3. Create the link in Razorpay (reference_id = deal ID, or "ID-2", "ID-3"...).
 *   4. Write the link URL and link ID back onto the deal's custom fields.
 *   5. Post a timeline comment saying the link was created.
 *
 * ERROR HANDLING RULE: every failure ends up as a timeline comment on the deal,
 * so the sales team sees it inside the CRM, not only in server logs. Each failure
 * becomes a FlowError, which carries:
 *   - the HTTP status and error code for whoever called the endpoint, and
 *   - a plain-language message for the sales team.
 *
 * The one failure we *can't* report on the deal is "deal not found": there is
 * no deal to comment on. That one only goes to the logs and the HTTP response.
 */

import { DealNotFoundError, BitrixApiError, BitrixUnavailableError, type BitrixClient } from "./bitrix.ts";
import type { Config } from "./config.ts";
import type { CreateLinkResponse, ErrorCode } from "./models.ts";
import {
  InvalidAmountError,
  RazorpayApiError,
  RazorpayUnavailableError,
  formatMoney,
  toPaise,
  type RazorpayClient,
} from "./razorpay.ts";

/** A failure with everything the route needs to answer the caller. */
export class FlowError extends Error {
  override name = "FlowError";
  readonly httpStatus: number;
  readonly code: ErrorCode;
  readonly dealId: string;

  constructor(httpStatus: number, code: ErrorCode, message: string, dealId: string, options?: ErrorOptions) {
    super(message, options);
    this.httpStatus = httpStatus;
    this.code = code;
    this.dealId = dealId;
  }
}

export interface PaymentLinkDeps {
  config: Pick<Config, "bitrixPaymentLinkField" | "bitrixPaymentIdField" | "razorpayAcceptPartial" | "paymentLinkExpireDays">;
  bitrix: Pick<BitrixClient, "getDealWithContact" | "updateDeal" | "safeComment">;
  razorpay: Pick<RazorpayClient, "createPaymentLinkForDeal">;
}

// Deals that have a link being created right now.
//
// WHY: if someone double-clicks, or a Bitrix robot fires twice, two requests for
// the same deal arrive together. Both would reach Razorpay, the second would get
// "reference_id already exists", and our retry would happily create link "54-2".
// Result: two live links for one deal. This set stops the second request early.
const inFlight = new Set<string>();

/** Run flow 1 for one deal. Throws FlowError on any expected failure. */
export async function createPaymentLinkForDeal(dealId: string, deps: PaymentLinkDeps): Promise<CreateLinkResponse> {
  if (inFlight.has(dealId)) {
    // No timeline comment: the first request is still running and will comment itself.
    throw new FlowError(409, "ALREADY_IN_PROGRESS", `A payment link for deal ${dealId} is already being created`, dealId);
  }
  inFlight.add(dealId);
  try {
    return await runFlow(dealId, deps);
  } catch (err) {
    const flowError = toFlowError(err, dealId);
    // Report on the deal, except when there's no deal to report on.
    if (flowError.code !== "DEAL_NOT_FOUND") {
      await deps.bitrix.safeComment(dealId, `Razorpay: Could not create payment link\n${flowError.message}`);
    }
    throw flowError;
  } finally {
    // `finally` runs whether we returned or threw, so the lock is always released.
    inFlight.delete(dealId);
  }
}

async function runFlow(dealId: string, deps: PaymentLinkDeps): Promise<CreateLinkResponse> {
  const { config, bitrix, razorpay } = deps;

  // ---- 1. Load the deal
  const deal = await bitrix.getDealWithContact(dealId);

  // ---- 2. Check the amount BEFORE calling Razorpay.
  // Razorpay would reject it too, but our message is clearer for the sales team,
  // and it saves a pointless API call.
  if (!deal.amount) {
    throw new FlowError(422, "INVALID_AMOUNT", "The deal has no amount. Fill in the deal's Amount field and try again.", dealId);
  }
  const paise = toPaise(deal.amount); // throws InvalidAmountError for zero, negative or too small

  // ---- 3. Create the link in Razorpay
  const link = await razorpay.createPaymentLinkForDeal({
    amount: deal.amount,
    currency: deal.currency,
    description: deal.title,
    dealId,
    customer: deal.contact,
    acceptPartial: config.razorpayAcceptPartial,
    expireInDays: config.paymentLinkExpireDays,
  });
  const amountDisplay = formatMoney(paise, deal.currency);
  console.info(`[payment-links] Deal ${dealId}: created ${link.id} (${link.reference_id}) for ${amountDisplay}`);

  // ---- 4. Save the link on the deal.
  // From here on the link EXISTS in Razorpay, so a failure must not lose it: if
  // saving to the deal fails, we still report success, include the link in the
  // comment, and set deal_updated=false.
  let dealUpdated = true;
  let updateProblem = "";
  try {
    await bitrix.updateDeal(dealId, {
      [config.bitrixPaymentLinkField]: link.short_url,
      [config.bitrixPaymentIdField]: link.id,
    });
  } catch (err) {
    dealUpdated = false;
    updateProblem = (err as Error).message;
    console.error(`[payment-links] Deal ${dealId}: link ${link.id} created but saving it to the deal failed`, err);
  }

  // ---- 5. Timeline comment
  const lines = [
    "Razorpay: Payment link created",
    `Amount: ${amountDisplay}`,
    `Link: ${link.short_url}`,
    `Link ID: ${link.id}`,
    // Tell the team if this deal has had links before (reference "54-2" etc.).
    link.reference_id !== dealId ? `Reference: ${link.reference_id} (this deal has had earlier links)` : undefined,
    dealUpdated
      ? undefined
      : `WARNING: the link could not be saved to the deal's fields (${updateProblem}). Copy it from this comment.`,
  ];
  await bitrix.safeComment(dealId, lines.filter(Boolean).join("\n"));

  return {
    status: "created",
    deal_id: dealId,
    payment_link_id: link.id,
    short_url: link.short_url,
    reference_id: link.reference_id,
    amount: paise,
    amount_display: amountDisplay,
    currency: deal.currency,
    deal_updated: dealUpdated,
  };
}

/**
 * Map whatever was thrown to a FlowError with a message the sales team can act on.
 *
 * The order matters: subclasses (DealNotFoundError) must be checked before their
 * parent classes (BitrixApiError), or the more specific case would never match.
 */
function toFlowError(err: unknown, dealId: string): FlowError {
  if (err instanceof FlowError) return err;

  if (err instanceof DealNotFoundError) {
    return new FlowError(
      404,
      "DEAL_NOT_FOUND",
      `Deal ${dealId} was not found in Bitrix24 (or the webhook user can't see it).`,
      dealId,
      { cause: err },
    );
  }
  if (err instanceof BitrixUnavailableError) {
    return new FlowError(503, "BITRIX_UNAVAILABLE", `Bitrix24 could not be reached: ${err.message}`, dealId, { cause: err });
  }
  if (err instanceof BitrixApiError) {
    return new FlowError(502, "BITRIX_ERROR", `Bitrix24 returned an error: ${err.message}`, dealId, { cause: err });
  }
  if (err instanceof InvalidAmountError) {
    return new FlowError(422, "INVALID_AMOUNT", `${err.message}. Fix the deal's Amount field and try again.`, dealId, { cause: err });
  }
  if (err instanceof RazorpayApiError) {
    let hint = "";
    if (err.isAuthError) {
      hint = "\nThe Razorpay API keys configured in the integration are wrong. Ask an admin to check them.";
    } else if (err.field?.startsWith("customer")) {
      hint = "\nCheck the email and phone number on the deal's contact.";
    }
    return new FlowError(502, "RAZORPAY_REJECTED", `Razorpay rejected the request: ${err.description}${hint}`, dealId, { cause: err });
  }
  if (err instanceof RazorpayUnavailableError) {
    return new FlowError(
      502,
      "RAZORPAY_UNAVAILABLE",
      // A timeout doesn't prove nothing happened: Razorpay may have created the
      // link and only the reply was lost. Warn before someone retries blindly.
      `Razorpay could not be reached: ${err.message}\n` +
        "A link may still have been created. Check the Razorpay dashboard (Payment Links) before trying again.",
      dealId,
      { cause: err },
    );
  }

  // Anything else is a bug in our code. Log the full details; keep the comment short.
  console.error(`[payment-links] Unexpected error for deal ${dealId}`, err);
  return new FlowError(500, "INTERNAL_ERROR", "Unexpected error in the payment integration. Details are in the server logs.", dealId, {
    cause: err,
  });
}

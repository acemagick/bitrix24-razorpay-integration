/**
 * The Recurring pipeline: yearly renewal payment links.
 *
 * The client sells 1-year subscriptions. Deals in the "Recurring" pipeline move
 * through three REMINDER stages before each renewal:
 *
 *   Active  ->  1 month  ->  15 days  ->  5 days      (then back to Active once paid)
 *
 * Each reminder stage calls POST /recurring/payment-links?deal_id=..&days=30|15|5,
 * which runs sendRenewalReminder() below. The rules:
 *
 *   - ONE link per subscription year. The three reminders of a year all use the
 *     SAME link, so the customer never gets three different links.
 *   - The link never expires: it stays valid until it's paid.
 *   - Next year's first reminder creates a new link, and so on every year.
 *   - The amount is the Amount of this deal (the one in the Recurring pipeline).
 *
 * HOW "THIS YEAR" IS DECIDED: a link belongs to the year it was created in. A
 * link created less than ~6 months ago is this year's; older is last year's.
 * The three reminders of a year are at most 30 days apart and renewals are 12
 * months apart, so 6 months separates them cleanly, with no extra date field.
 *
 * This is kept separate from paymentLinks.ts (the Deals pipeline), whose rules
 * are different: there, a paid link means "don't create another one, ever".
 * Shared building blocks (error messages, the "couldn't save the link" safety
 * net, the deal lock) are reused from there, so both behave the same way when
 * something goes wrong.
 */

import type { BitrixClient } from "./bitrix.ts";
import type { Config } from "./config.ts";
import { RenewalReminderDays, type RecurringLinkResponse, type RenewalReminder } from "./models.ts";
import { FlowError, cancelUnsavedLink, isUnknownIdError, previousLinkError, toFlowError } from "./paymentLinks.ts";
import { RazorpayApiError, formatMoney, toPaise, type PaymentLink, type RazorpayClient } from "./razorpay.ts";
import { MemoryDealLock, type DealLock, type UnresolvedLinkRecords } from "./storage.ts";

/** A link younger than this counts as this year's link. */
export const SAME_YEAR_SECONDS = 183 * 24 * 60 * 60; // about 6 months

const REMINDER_LABELS: Record<RenewalReminder, string> = { 30: "1 month", 15: "15 days", 5: "5 days" };

export interface RecurringLinkDeps {
  config: Pick<Config, "bitrixPaymentLinkField" | "bitrixPaymentIdField" | "recurringCategoryId">;
  bitrix: Pick<BitrixClient, "getDealWithContact" | "updateDeal" | "safeComment">;
  razorpay: Pick<RazorpayClient, "createPaymentLinkForDeal" | "fetchPaymentLink" | "cancelPaymentLink">;
  unresolvedLinks: UnresolvedLinkRecords;
  /** Same role as in the Deals flow: no two requests for one deal at once. */
  dealLock?: DealLock;
  /** Current time in milliseconds. Tests replace it to jump a year ahead. */
  now?: () => number;
}

const defaultDealLock = new MemoryDealLock();

/** Is `days` one of the three reminders (30, 15, 5)? */
export function isRenewalReminder(days: number): days is RenewalReminder {
  return (RenewalReminderDays as readonly number[]).includes(days);
}

/**
 * Handle one renewal reminder for a Recurring-pipeline deal: create this year's
 * link, or reuse it, or report that it's already paid. Every failure is also
 * posted on the deal as a timeline comment, like the Deals flow.
 */
export async function sendRenewalReminder(
  dealId: string,
  daysLeft: RenewalReminder,
  deps: RecurringLinkDeps,
): Promise<RecurringLinkResponse> {
  const lock = deps.dealLock ?? defaultDealLock;
  const report = async (flowError: FlowError) => {
    if (flowError.code !== "DEAL_NOT_FOUND") {
      await deps.bitrix.safeComment(
        dealId,
        `Razorpay: Could not prepare the renewal link (${REMINDER_LABELS[daysLeft]} reminder)\n${flowError.message}`,
      );
    }
    return flowError;
  };

  let locked: boolean;
  try {
    locked = await lock.acquire(dealId);
  } catch (err) {
    throw await report(toFlowError(err, dealId));
  }
  if (!locked) {
    throw new FlowError(409, "ALREADY_IN_PROGRESS", `A renewal link for deal ${dealId} is already being prepared`, dealId);
  }

  try {
    return await runReminder(dealId, daysLeft, deps);
  } catch (err) {
    throw await report(toFlowError(err, dealId));
  } finally {
    try {
      await lock.release(dealId);
    } catch (err) {
      console.error(`[recurring] Deal ${dealId}: could not release the lock`, err);
    }
  }
}

async function runReminder(dealId: string, daysLeft: RenewalReminder, deps: RecurringLinkDeps): Promise<RecurringLinkResponse> {
  const { config, bitrix, razorpay } = deps;
  const nowSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  const label = REMINDER_LABELS[daysLeft];

  if (!config.recurringCategoryId) {
    throw new FlowError(404, "NOT_FOUND", "Renewal links are switched off (RECURRING_CATEGORY_ID is not set).", dealId);
  }

  // ---- 1. Load the deal, and make sure it's in the Recurring pipeline.
  // A reminder rule accidentally added to another pipeline must not start
  // creating yearly links there.
  const deal = await bitrix.getDealWithContact(dealId);
  if (deal.categoryId !== config.recurringCategoryId) {
    throw new FlowError(
      422,
      "NOT_RECURRING_DEAL",
      `This deal isn't in the Recurring pipeline, so no renewal link was made. ` +
        `(Renewal reminders only work for deals in pipeline ${config.recurringCategoryId}; this deal is in pipeline ${deal.categoryId}.)`,
      dealId,
    );
  }

  // ---- 2. Find the deal's current link.
  // Normally the one saved in its Link ID field. A link that was created but
  // couldn't be saved (the "unresolved" record) is dealt with first.
  const savedLinkId = String(deal.raw[config.bitrixPaymentIdField] ?? "").trim();
  const adopted = await settleUnresolvedLink(dealId, savedLinkId, nowSeconds, deps);
  const current = adopted ?? (await fetchSavedLink(dealId, savedLinkId, razorpay));

  // ---- 3. Is it this year's link?
  if (current && isThisYear(current, nowSeconds)) {
    if (current.status === "paid") {
      await bitrix.safeComment(
        dealId,
        [
          `Razorpay: Renewal reminder (${label} left)`,
          `This year's renewal is already paid (${formatMoney(current.amount, current.currency)}). No payment needed.`,
          `Link ID: ${current.id}`,
        ].join("\n"),
      );
      return response("already_paid", dealId, daysLeft, current);
    }
    if (current.status === "created" || current.status === "partially_paid") {
      await bitrix.safeComment(
        dealId,
        [
          `Razorpay: Renewal reminder (${label} left)`,
          "This year's renewal is still unpaid. Same link as before:",
          `Amount: ${formatMoney(current.amount - (current.amount_paid ?? 0), current.currency)}`,
          `Link: ${current.short_url}`,
          `Link ID: ${current.id}`,
        ].join("\n"),
      );
      return response("reminded", dealId, daysLeft, current);
    }
    // cancelled or expired (e.g. someone cancelled it by hand): make a new one for this year.
  }

  // ---- 4. A new link is needed: none yet, or only last year's.
  // Last year's link still payable? Cancel it first, so only one link can be paid.
  let cancelledPrevious: string | undefined;
  if (current && (current.status === "created" || current.status === "partially_paid")) {
    try {
      await razorpay.cancelPaymentLink(current.id);
    } catch (err) {
      throw previousLinkError(dealId, `Could not cancel last year's unpaid renewal link (${current.id})`, err);
    }
    cancelledPrevious = current.id;
    console.info(`[recurring] Deal ${dealId}: cancelled last year's unpaid link ${current.id}`);
  }

  // ---- 5. Create this year's link, with the Recurring deal's own amount.
  if (!deal.amount) {
    throw new FlowError(422, "INVALID_AMOUNT", "The deal has no amount. Fill in the deal's Amount field and try again.", dealId);
  }
  const paise = toPaise(deal.amount); // throws for zero, negative or too small
  // The year of the renewal itself, not of the reminder: a 1-month reminder on
  // 15 December is for January's renewal, so it's next year's link.
  const renewalSeconds = nowSeconds + daysLeft * 24 * 60 * 60;
  const year = String(new Date(renewalSeconds * 1000).getUTCFullYear());
  const link = await razorpay.createPaymentLinkForDeal({
    amount: deal.amount,
    currency: deal.currency,
    description: `${deal.title}: renewal ${year}`,
    dealId,
    customer: deal.contact,
    referenceBase: `${dealId}-${year}`, // the customer's "RECEIPT", e.g. 66-2026
    extraNotes: { subscription_year: year, pipeline: "recurring" },
    // No expireInDays: the link stays valid until it's paid.
  });
  console.info(`[recurring] Deal ${dealId}: created renewal link ${link.id} (${link.reference_id})`);

  // ---- 6. Save it on the deal, so the next reminders (and payments) find it.
  try {
    await bitrix.updateDeal(dealId, {
      [config.bitrixPaymentLinkField]: link.short_url,
      [config.bitrixPaymentIdField]: link.id,
    });
  } catch (err) {
    console.error(`[recurring] Deal ${dealId}: link ${link.id} created but saving it to the deal failed`, err);
    throw await cancelUnsavedLink(dealId, link.id, link.short_url, err, deps);
  }

  const amountDisplay = formatMoney(paise, deal.currency);
  await bitrix.safeComment(
    dealId,
    [
      `Razorpay: Renewal payment link created (${year})`,
      `Reminder: ${label} left before renewal`,
      `Amount: ${amountDisplay}`,
      `Link: ${link.short_url}`,
      `Link ID: ${link.id}`,
      "The same link is used for all of this year's reminders, and it stays valid until paid.",
      cancelledPrevious ? `Last year's unpaid link (${cancelledPrevious}) was cancelled, so only this link can be paid.` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return {
    ...response("created", dealId, daysLeft, { ...link, amount: paise, currency: deal.currency }),
    ...(cancelledPrevious && { cancelled_previous_link_id: cancelledPrevious }),
  };
}

// --------------------------------------------------------------------------- helpers

/** A link created less than ~6 months ago belongs to this year. */
function isThisYear(link: PaymentLink, nowSeconds: number): boolean {
  if (link.created_at === undefined) {
    // Razorpay always sends it; if it's ever missing, assume "this year", the
    // safe side: better one reminder too few than a second yearly charge.
    console.warn(`[recurring] Link ${link.id} has no created_at; treating it as this year's`);
    return true;
  }
  return nowSeconds - link.created_at < SAME_YEAR_SECONDS;
}

/**
 * Fetch the link saved on the deal. Returns undefined if there is none, the
 * field holds something that isn't a Razorpay link ID, or Razorpay doesn't know
 * the ID. Other failures stop the reminder: without knowing the current link's
 * state we could charge twice.
 */
async function fetchSavedLink(
  dealId: string,
  savedLinkId: string,
  razorpay: RecurringLinkDeps["razorpay"],
): Promise<PaymentLink | undefined> {
  if (!/^plink_\w+$/.test(savedLinkId)) return undefined;
  try {
    return await razorpay.fetchPaymentLink(savedLinkId);
  } catch (err) {
    if (err instanceof RazorpayApiError && isUnknownIdError(err)) {
      console.warn(`[recurring] Deal ${dealId}: saved link ${savedLinkId} not found in Razorpay, ignoring it`);
      return undefined;
    }
    throw previousLinkError(dealId, `Could not check the deal's current renewal link (${savedLinkId})`, err);
  }
}

/**
 * Deal with a link that was created earlier but couldn't be saved to the deal.
 *
 *   still payable          cancel it (nobody got it through the normal route)
 *   paid within 6 months   it IS this year's payment: save it on the deal and use it
 *   anything else          just forget it
 *
 * Returns the link when it's adopted as this year's, otherwise undefined.
 */
async function settleUnresolvedLink(
  dealId: string,
  savedLinkId: string,
  nowSeconds: number,
  deps: RecurringLinkDeps,
): Promise<PaymentLink | undefined> {
  const unresolvedId = await deps.unresolvedLinks.get(dealId);
  if (!unresolvedId) return undefined;

  let adopted: PaymentLink | undefined;
  if (unresolvedId !== savedLinkId) {
    const link = await fetchSavedLink(dealId, unresolvedId, deps.razorpay);
    if (link?.status === "created" || link?.status === "partially_paid") {
      try {
        await deps.razorpay.cancelPaymentLink(link.id);
      } catch (err) {
        throw previousLinkError(dealId, `Could not cancel an earlier renewal link that was never saved to the deal (${link.id})`, err);
      }
    } else if (link?.status === "paid" && isThisYear(link, nowSeconds)) {
      await deps.bitrix.updateDeal(dealId, {
        [deps.config.bitrixPaymentLinkField]: link.short_url,
        [deps.config.bitrixPaymentIdField]: link.id,
      });
      adopted = link;
    }
  }
  await deps.unresolvedLinks.delete(dealId);
  return adopted;
}

function response(
  status: RecurringLinkResponse["status"],
  dealId: string,
  daysLeft: RenewalReminder,
  link: Pick<PaymentLink, "id" | "short_url" | "reference_id" | "amount" | "currency">,
): RecurringLinkResponse {
  return {
    status,
    deal_id: dealId,
    days_left: daysLeft,
    payment_link_id: link.id,
    short_url: link.short_url,
    reference_id: link.reference_id,
    amount: link.amount,
    amount_display: formatMoney(link.amount, link.currency),
    currency: link.currency,
  };
}

/**
 * Flow 1: create a Razorpay payment link for a Bitrix24 deal.
 *
 *   1. Load the deal (amount, currency, title) and its contact from Bitrix24.
 *   2. Check the amount is usable.
 *   3. If the deal already has a link: cancel it if unpaid, refuse if (partly) paid.
 *   4. Create the link in Razorpay (reference_id = deal ID, or "ID-2", "ID-3"...).
 *   5. Write the link URL and link ID back onto the deal's custom fields.
 *   6. Post a timeline comment saying the link was created.
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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
import { MemoryDealLock, StorageError, type DealLock, type UnresolvedLinkRecords } from "./storage.ts";

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
  razorpay: Pick<RazorpayClient, "createPaymentLinkForDeal" | "fetchPaymentLink" | "cancelPaymentLink">;
  unresolvedLinks: UnresolvedLinkRecords;
  /**
   * The "a link is being created for this deal right now" lock.
   *
   * WHY: if someone double-clicks, or a Bitrix robot fires twice, two requests for
   * the same deal arrive together. Both would reach Razorpay, the second would get
   * "reference_id already exists", and our retry would happily create link "54-2".
   * Result: two live links for one deal. The lock stops the second request early.
   *
   * Defaults to one shared in-memory lock, right for a single server. On Lambda
   * the DynamoDB lock is passed in, so separate copies see each other's locks.
   */
  dealLock?: DealLock;
}

const defaultDealLock = new MemoryDealLock();

/**
 * Remembers, per deal, a link we created but could neither save to the deal nor
 * cancel, in a small JSON file.
 *
 * WHY: the deal's Link ID field doesn't point to such a link, so the usual
 * "retire the previous link" check can't see it. The next request for the deal
 * must deal with it first, or the customer could end up with two payable links.
 *
 * WHY A FILE (not just memory): so a restart doesn't forget a link that may
 * still be payable. Like ProcessedEventStore, it's fine for one server instance;
 * on AWS Lambda, DynamoUnresolvedLinks (dynamoStorage.ts) is used instead.
 */
export class UnresolvedLinkStore implements UnresolvedLinkRecords {
  private readonly links = new Map<string, string>(); // deal id -> link id
  private writeChain: Promise<void> = Promise.resolve();
  private lastSave: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Load recorded links from disk. Call once at startup. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // nothing recorded yet
      throw err;
    }
    // Unlike processed events, silently starting empty here could let a second
    // payable link be created, so a corrupt file stops the service instead.
    const entries = JSON.parse(text) as [string, string][];
    for (const [dealId, linkId] of entries) this.links.set(dealId, linkId);
    if (this.links.size) console.warn(`[payment-links] Loaded ${this.links.size} unresolved payment links from ${this.path}`);
  }

  get(dealId: string): string | undefined {
    return this.links.get(dealId);
  }

  /** Record a link. Resolves once it's on disk; rejects if it couldn't be saved. */
  set(dealId: string, linkId: string): Promise<void> {
    // In memory straight away, so it blocks new links even if the save fails.
    this.links.set(dealId, linkId);
    return this.save();
  }

  /** Forget a link. Only takes effect once that's on disk; rejects if it couldn't be saved. */
  delete(dealId: string): Promise<void> {
    if (!this.links.has(dealId)) return Promise.resolve();
    return this.save((links) => links.delete(dealId));
  }

  /** Resolves once every save started so far has finished; rejects if the latest one failed. */
  flush(): Promise<void> {
    return this.lastSave;
  }

  /**
   * Write the records (with `change` applied) to disk, then apply `change` in memory.
   *
   * Saves are chained so they never overlap. Each writes the whole current state,
   * so a later successful save also stores anything an earlier failed one missed.
   * A temp file is renamed over the real one; if the rename fails, the save fails
   * and the old file is left untouched rather than rewritten in place.
   */
  private save(change?: (links: Map<string, string>) => void): Promise<void> {
    const write = this.writeChain.then(async () => {
      const next = new Map(this.links);
      change?.(next);
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify([...next.entries()]), "utf8");
      await rename(tmp, this.path);
      change?.(this.links);
    });
    // Keep the chain going after a failure; the caller gets the rejection via `write`.
    this.writeChain = write.catch(() => {});
    this.lastSave = write;
    return write;
  }
}

/** Run flow 1 for one deal. Throws FlowError on any expected failure. */
export async function createPaymentLinkForDeal(dealId: string, deps: PaymentLinkDeps): Promise<CreateLinkResponse> {
  const lock = deps.dealLock ?? defaultDealLock;
  const report = async (flowError: FlowError) => {
    // Report on the deal, except when there's no deal to report on.
    if (flowError.code !== "DEAL_NOT_FOUND") {
      await deps.bitrix.safeComment(dealId, `Razorpay: Could not create payment link\n${flowError.message}`);
    }
    return flowError;
  };

  let locked: boolean;
  try {
    locked = await lock.acquire(dealId);
  } catch (err) {
    // Without the lock we can't rule out a second link, so don't start.
    throw await report(toFlowError(err, dealId));
  }
  if (!locked) {
    // No timeline comment: the first request is still running and will comment itself.
    throw new FlowError(409, "ALREADY_IN_PROGRESS", `A payment link for deal ${dealId} is already being created`, dealId);
  }

  try {
    return await runFlow(dealId, deps);
  } catch (err) {
    throw await report(toFlowError(err, dealId));
  } finally {
    // `finally` runs whether we returned or threw, so the lock is always released.
    // If releasing fails (storage unreachable), the lock runs out by itself
    // after a minute (see dynamoStorage.ts), so just log it.
    try {
      await lock.release(dealId);
    } catch (err) {
      console.error(`[payment-links] Deal ${dealId}: could not release the lock`, err);
    }
  }
}

async function runFlow(dealId: string, deps: PaymentLinkDeps): Promise<CreateLinkResponse> {
  const { config, bitrix, razorpay, unresolvedLinks } = deps;

  // ---- 1. Load the deal
  const deal = await bitrix.getDealWithContact(dealId);

  // ---- 2. Check the amount BEFORE calling Razorpay.
  // Razorpay would reject it too, but our message is clearer for the sales team,
  // and it saves a pointless API call.
  if (!deal.amount) {
    throw new FlowError(422, "INVALID_AMOUNT", "The deal has no amount. Fill in the deal's Amount field and try again.", dealId);
  }
  const paise = toPaise(deal.amount); // throws InvalidAmountError for zero, negative or too small

  // ---- 3. Deal with the previous link, if there is one.
  // Done BEFORE creating the new link: if the old one can't be cancelled, we stop
  // here, so the customer is never left holding two payable links.
  const previousLinkId = String(deal.raw[config.bitrixPaymentIdField] ?? "").trim();

  // A link from an earlier request that couldn't be saved or cancelled comes first.
  // It stays recorded (and keeps blocking new links) until it's cancelled, found
  // unusable, or the team puts its ID into the deal's field by hand. From then on
  // the field tracks it like any other link.
  const unresolvedLinkId = await unresolvedLinks.get(dealId);
  if (unresolvedLinkId && unresolvedLinkId !== previousLinkId) {
    await retirePreviousLink(
      dealId,
      unresolvedLinkId,
      deps,
      `This link was never saved to the deal. To resolve it, put ${unresolvedLinkId} into the deal's Razorpay Link ID field ` +
        `(${config.bitrixPaymentIdField}); after that, clearing the field allows a new link as usual.`,
    );
  }
  if (unresolvedLinkId) {
    try {
      await unresolvedLinks.delete(dealId);
    } catch (err) {
      // The record still says the link is unresolved, so don't create another one yet.
      throw new FlowError(
        500,
        "INTERNAL_ERROR",
        `Link ${unresolvedLinkId} is resolved, but the integration could not update its records on the server (${(err as Error).message}). ` +
          "No new link was created. Try again; if it keeps failing, ask an admin to check the server's disk.",
        dealId,
        { cause: err },
      );
    }
  }

  const cancelledPreviousLinkId = previousLinkId ? await retirePreviousLink(dealId, previousLinkId, deps) : undefined;

  // ---- 4. Create the link in Razorpay
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

  // ---- 5. Save the link on the deal.
  // From here on the link EXISTS in Razorpay. If the deal doesn't record it, a
  // retry can't find it to cancel it, and the customer could end up with two
  // payable links. So if saving fails, cancel the new link and report failure.
  try {
    await bitrix.updateDeal(dealId, {
      [config.bitrixPaymentLinkField]: link.short_url,
      [config.bitrixPaymentIdField]: link.id,
    });
  } catch (err) {
    console.error(`[payment-links] Deal ${dealId}: link ${link.id} created but saving it to the deal failed`, err);
    throw await cancelUnsavedLink(dealId, link.id, link.short_url, err, deps);
  }

  // ---- 6. Timeline comment
  const lines = [
    "Razorpay: Payment link created",
    `Amount: ${amountDisplay}`,
    `Link: ${link.short_url}`,
    `Link ID: ${link.id}`,
    // Tell the team if this deal has had links before (reference "54-2" etc.).
    link.reference_id !== dealId ? `Reference: ${link.reference_id} (this deal has had earlier links)` : undefined,
    cancelledPreviousLinkId
      ? `The previous link (${cancelledPreviousLinkId}) was cancelled, so only this new link can be paid.`
      : undefined,
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
    deal_updated: true,
    ...(cancelledPreviousLinkId && { cancelled_previous_link_id: cancelledPreviousLinkId }),
  };
}

/**
 * Make sure the deal's current link can no longer be paid, before a new one is
 * created. Returns the ID of the link it cancelled, or undefined if there was
 * nothing to cancel.
 *
 * Depending on the old link's status:
 *   created                  still payable: cancel it
 *   expired / cancelled      already unusable: nothing to do
 *   paid / partially_paid    the customer has paid: REFUSE to create a new
 *                            link, so they're never asked to pay twice
 *
 * If the old link can't be checked or cancelled (Razorpay down, cancel refused
 * because the customer paid a second ago...), we stop with an error instead of
 * risking two payable links.
 */
async function retirePreviousLink(
  dealId: string,
  previousLinkId: string,
  deps: PaymentLinkDeps,
  paidHint = `If a second payment really is needed, clear the deal's Razorpay Link ID field (${deps.config.bitrixPaymentIdField}) and try again.`,
): Promise<string | undefined> {
  const { razorpay, config } = deps;

  // Someone may have typed into the field by hand. Only a real Razorpay link ID
  // is worth asking Razorpay about.
  if (!/^plink_\w+$/.test(previousLinkId)) {
    console.warn(`[payment-links] Deal ${dealId}: ignoring "${previousLinkId}" in ${config.bitrixPaymentIdField}, not a Razorpay link ID`);
    return undefined;
  }

  let previous;
  try {
    previous = await razorpay.fetchPaymentLink(previousLinkId);
  } catch (err) {
    // An ID Razorpay doesn't know (e.g. a test-mode link while using live keys)
    // can't be paid through this account, so there's nothing to cancel.
    if (err instanceof RazorpayApiError && isUnknownIdError(err)) {
      console.warn(`[payment-links] Deal ${dealId}: previous link ${previousLinkId} not found in Razorpay, ignoring it`);
      return undefined;
    }
    throw previousLinkError(dealId, `Could not check the deal's previous payment link (${previousLinkId})`, err);
  }

  switch (previous.status) {
    case "paid":
    case "partially_paid": {
      const paid = formatMoney(previous.amount_paid, previous.currency);
      const total = formatMoney(previous.amount, previous.currency);
      throw new FlowError(
        409,
        "ALREADY_PAID",
        `The customer has already paid ${paid} of ${total} on the current link (${previous.id}). ` +
          `No new link was created, so they aren't asked to pay twice.\n${paidHint}`,
        dealId,
      );
    }
    case "created":
      try {
        await razorpay.cancelPaymentLink(previous.id);
      } catch (err) {
        throw previousLinkError(dealId, `Could not cancel the deal's previous payment link (${previous.id})`, err);
      }
      console.info(`[payment-links] Deal ${dealId}: cancelled previous link ${previous.id}`);
      return previous.id;
    default:
      // expired or cancelled: the customer can't use it any more.
      return undefined;
  }
}

/**
 * The new link was created but couldn't be saved to the deal. Cancel it so it
 * can't be paid, and return a FlowError describing what happened. If the cancel
 * fails too, the error says the link is still live and must be cancelled by hand.
 */
async function cancelUnsavedLink(
  dealId: string,
  linkId: string,
  shortUrl: string,
  updateErr: unknown,
  deps: PaymentLinkDeps,
): Promise<FlowError> {
  const saveError = toFlowError(updateErr, dealId);
  try {
    await deps.razorpay.cancelPaymentLink(linkId);
    console.info(`[payment-links] Deal ${dealId}: cancelled unsaved link ${linkId}`);
    return new FlowError(
      saveError.httpStatus,
      saveError.code,
      `${saveError.message}\nThe new link (${linkId}) could not be saved to the deal, so it was cancelled. Try again.`,
      dealId,
      { cause: updateErr },
    );
  } catch (cancelErr) {
    console.error(`[payment-links] Deal ${dealId}: could not cancel unsaved link ${linkId}`, cancelErr);
    // Remember it (on disk), so the next request for this deal deals with it before creating another.
    let recordProblem = "";
    try {
      await deps.unresolvedLinks.set(dealId, linkId);
    } catch (err) {
      recordProblem = (err as Error).message;
      console.error(`[payment-links] Deal ${dealId}: could not record unresolved link ${linkId} on disk`, err);
    }
    const reason = cancelErr instanceof RazorpayApiError ? cancelErr.description : (cancelErr as Error).message;
    return new FlowError(
      saveError.httpStatus,
      saveError.code,
      `${saveError.message}\nThe new link (${linkId}, ${shortUrl}) could not be saved to the deal, and cancelling it failed too (${reason}). ` +
        (recordProblem
          ? `It is STILL PAYABLE, and it could not be recorded on the server either (${recordProblem}), ` +
            "so a restart would forget it. Cancel it in the Razorpay dashboard now."
          : "It is STILL PAYABLE for now. No new link will be created for this deal until it is cancelled " +
            "(the next attempt will try) or dealt with; you can also cancel it in the Razorpay dashboard."),
      dealId,
      { cause: updateErr },
    );
  }
}

/** Razorpay's answer for an ID that doesn't exist in this account/mode. */
function isUnknownIdError(err: RazorpayApiError): boolean {
  return err.status === 404 || (err.status === 400 && /does not exist|not found|not a valid id/i.test(err.description));
}

/** Wrap a failure to check/cancel the old link with context the sales team can act on. */
function previousLinkError(dealId: string, what: string, err: unknown): FlowError {
  const reason = err instanceof RazorpayApiError ? err.description : (err as Error).message;
  const code: ErrorCode = err instanceof RazorpayApiError ? "RAZORPAY_REJECTED" : "RAZORPAY_UNAVAILABLE";
  return new FlowError(
    502,
    code,
    `${what}: ${reason}\nNo new link was created, so the customer can't end up with two payable links. Try again, or check the link in the Razorpay dashboard.`,
    dealId,
    { cause: err },
  );
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
  if (err instanceof StorageError) {
    return new FlowError(
      503,
      "STORAGE_UNAVAILABLE",
      `The integration could not reach its database, so no new link was created. Try again in a minute.\n(${err.message})`,
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

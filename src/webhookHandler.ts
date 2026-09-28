/**
 * Everything that happens to a Razorpay webhook after it arrives:
 *
 *   1. verifySignature()      Is this really from Razorpay?        (security)
 *   2. ProcessedEventStore    Have we already handled this event?  (idempotency)
 *   3. resolveDealId()        Which Bitrix deal does it belong to?
 *   4. buildComment()         What should the sales team read?
 *   5. processWebhook()       Post the comment (and maybe move the deal to Won).
 *
 * The Express route (in main.ts) does steps 1-2 itself, answers Razorpay with
 * 200 straight away, then runs step 5 in the background.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BitrixClient } from "./bitrix.ts";
import { isHandledEvent, type RazorpayWebhook } from "./models.ts";
import { formatMoney, type RazorpayClient } from "./razorpay.ts";
import type { EventStore, UnresolvedLinkRecords } from "./storage.ts";

// =========================================================================== 1. signature

/**
 * Check the X-Razorpay-Signature header.
 *
 * HOW IT WORKS: you and Razorpay share a secret (set when creating the webhook).
 * Razorpay computes HMAC-SHA256(secret, request body) and sends the result as a
 * hex string in the header. We compute the same thing. Only someone who knows the
 * secret can produce a matching value, so a match proves the request came from
 * Razorpay and that the body wasn't changed on the way.
 *
 * WHY THE RAW BODY: the HMAC is over the exact bytes Razorpay sent. If we parsed
 * the JSON and re-serialised it, spacing or key order could change and the
 * signature would never match. So main.ts gives us the untouched Buffer.
 *
 * WHY timingSafeEqual: a normal `===` stops at the first differing character,
 * so it returns slightly faster the earlier the mismatch is. An attacker making
 * many requests could measure that and guess the signature one character at a
 * time. timingSafeEqual always takes the same time.
 */
export function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signature.trim().toLowerCase(), "utf8");
  // timingSafeEqual throws if the lengths differ, so check that first. Leaking
  // "wrong length" is harmless: everyone knows SHA-256 hex is 64 characters.
  return expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf);
}

// =========================================================================== 2. idempotency

/**
 * The ID we use to recognise a repeated delivery of the same event.
 *
 * Razorpay sends an `x-razorpay-event-id` header that stays the same when it
 * re-sends an event, so that's the natural key. If it's ever missing, fall back
 * to a key built from the event's own content.
 */
export function dedupeKey(eventIdHeader: string | undefined, webhook: RazorpayWebhook): string {
  if (eventIdHeader) return eventIdHeader;
  const p = webhook.payload;
  const entityId = p.payment?.entity.id ?? p.payment_link?.entity.id ?? "unknown";
  return `${webhook.event}:${entityId}:${webhook.created_at ?? ""}`;
}

/**
 * Remembers which webhook events have been processed, in a small JSON file.
 *
 * WHY: Razorpay guarantees "at least once" delivery. If our 200 reply gets lost,
 * or they have a hiccup, they send the event again, and without this the deal
 * would get two identical "Payment successful" comments.
 *
 * WHY A FILE (not just memory): so a restart of the service doesn't forget
 * everything. It's deliberately simple: fine for one server instance. On AWS
 * Lambda (no permanent disk, several copies at once) DynamoEventStore in
 * dynamoStorage.ts is used instead; both follow the EventStore contract.
 *
 * The oldest entries are dropped after `maxEntries`. Razorpay only retries for
 * about 24 hours, so very old IDs are no longer needed.
 */
export class ProcessedEventStore implements EventStore {
  // A Map remembers insertion order, so the first key is always the oldest.
  private readonly seen = new Map<string, string>(); // event id -> ISO time processed
  // Claimed but not finished yet. Memory only: if the process dies mid-work,
  // the event was never processed, so a resend must be handled again.
  private readonly inProgress = new Set<string>();
  // Processed, but not on disk yet (save pending or failed). A restart would
  // forget these, so they aren't reported as durable duplicates; see ensureSaved().
  // Maps event id -> the completion's generation, so a save that captured an
  // earlier completion can't clear the marker of a newer one (an id that was
  // dropped from `seen` and then processed again).
  private readonly unsaved = new Map<string, number>();
  private generation = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly maxEntries: number;

  constructor(path: string, maxEntries = 5000) {
    this.path = path;
    this.maxEntries = maxEntries;
  }

  /** Load previously processed IDs from disk. Call once at startup. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // first run: nothing saved yet
      throw err;
    }
    try {
      const entries = JSON.parse(text) as [string, string][];
      for (const [id, at] of entries) this.seen.set(id, at);
      console.info(`[webhook] Loaded ${this.seen.size} processed event IDs from ${this.path}`);
    } catch {
      // A corrupt file shouldn't stop the service from starting. Worst case is
      // one duplicate comment if Razorpay retries an old event.
      console.error(`[webhook] ${this.path} is not valid JSON; starting with an empty event store`);
    }
  }

  /**
   * Claim an event before processing it. Returns true if it's new (process it,
   * then call complete() or release()), false if it's already processed or
   * still being processed (use has() to tell which).
   *
   * WHY check and record in one step: Razorpay can send the same event twice
   * almost at once. Because Node runs our code on one thread, the check and the
   * record below happen with nothing in between (there's no `await` between
   * them), so two simultaneous deliveries can't both see "new".
   *
   * The claim is NOT saved to disk: only complete() does that, so an event whose
   * processing never finished isn't remembered as done.
   */
  claim(eventId: string): boolean {
    if (this.seen.has(eventId) || this.inProgress.has(eventId)) return false;
    this.inProgress.add(eventId);
    return true;
  }

  /**
   * The claimed event has been processed: remember it for good. It counts as
   * processed in memory straight away; the returned promise resolves once that's
   * on disk, and rejects if the save failed (the failure is also logged).
   */
  complete(eventId: string): Promise<void> {
    this.inProgress.delete(eventId);
    this.seen.set(eventId, new Date().toISOString());
    this.unsaved.set(eventId, ++this.generation);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
      this.unsaved.delete(oldest);
    }
    return this.persist();
  }

  /**
   * Resolves once a processed event is on disk, saving again if its earlier
   * save failed (or is still pending); rejects if it still can't be saved.
   */
  ensureSaved(eventId: string): Promise<void> {
    return this.unsaved.has(eventId) ? this.persist() : Promise.resolve();
  }

  /** Processing of the claimed event didn't finish: forget the claim, so a resend is processed. */
  release(eventId: string): void {
    this.inProgress.delete(eventId);
  }

  /** True if the event has been fully processed (not necessarily on disk yet: see ensureSaved()). */
  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /** Resolves once every save started so far has finished. Handy for tests and shutdown. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  /**
   * Save to disk, and return this save's own result (rejects if it failed).
   * Callers may ignore it: the failure is logged here, and the chain below
   * handles the rejection, so an ignored one can't become an unhandled rejection.
   *
   * Saves are chained one after another so two writes never overlap and
   * interleave. Each one writes a temp file and renames it over the real file,
   * so a crash mid-write can't leave a half-written, corrupt file.
   */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.seen.entries()]);
    // Every unsaved id is in `seen`, so in this snapshot; remember which completion.
    const captured = [...this.unsaved.entries()];
    const write = this.writeChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      try {
        await rename(tmp, this.path);
      } catch {
        // On Windows, rename can fail with EPERM if another process (often
        // antivirus) has the file open. Fall back to writing directly.
        await writeFile(this.path, snapshot, "utf8");
      }
      // These completions are on disk now, unless the id has been completed again since.
      for (const [id, generation] of captured) {
        if (this.unsaved.get(id) === generation) this.unsaved.delete(id);
      }
    });
    // Keep the chain going after a failure.
    this.writeChain = write.catch((err) => console.error(`[webhook] Could not save processed events to ${this.path}`, err));
    return write;
  }
}

// =========================================================================== 3. which deal?

export interface ResolvedDeal {
  dealId: string;
  /** Where we found it; logged to help debug unexpected payloads. */
  source: string;
}

/** What resolveDealId needs to check a webhook against this service's own records. */
export interface DealLookupDeps {
  bitrix: Pick<BitrixClient, "getDeal">;
  razorpay: Pick<RazorpayClient, "fetchOrder" | "fetchPaymentLink">;
  /** The deal field where this service saves each deal's current link ID (BITRIX_PAYMENT_ID_FIELD). */
  linkIdField: string;
  /** Links this service created but couldn't save to their deal. */
  unresolvedLinks: Pick<UnresolvedLinkRecords, "get">;
}

/**
 * Work out which Bitrix deal a webhook belongs to.
 *
 * STEP 1, the claim: which deal do the notes name? Most reliable place first:
 *
 *   1. payment_link.notes.bitrix_deal_id  we put it there when creating the link
 *   2. payment.notes.bitrix_deal_id       for payment.failed, which has no payment_link
 *   3. order.notes.bitrix_deal_id         if the order came with the payload
 *   4. GET /orders/{order_id}             last resort for payment.failed: ask Razorpay
 *
 * The reference_id ("42", "42-2") is deliberately NOT used: a link without our
 * note was made some other way (e.g. by hand in the dashboard), and its
 * reference could point at an unrelated deal that happens to have that number.
 *
 * STEP 2, the check: notes alone prove nothing. The webhook signature only
 * proves Razorpay sent the event; anyone who can set notes (a website's
 * Checkout, a dashboard user) can write bitrix_deal_id, or copy it from one of
 * our links. So the event's link must be one this service recorded for that
 * deal: the link ID saved on the deal, or one in the unresolved-link store.
 * This also covers links created before any of this existed, since they were
 * saved to their deal the same way.
 *
 * Returns undefined if there's no claim or the check fails. That's normal for
 * payment.failed events from payments that have nothing to do with our links
 * (e.g. your website's checkout), because Razorpay sends payment.failed for
 * every payment on the account.
 */
export async function resolveDealId(webhook: RazorpayWebhook, deps: DealLookupDeps): Promise<ResolvedDeal | undefined> {
  const link = webhook.payload.payment_link?.entity;
  const payment = webhook.payload.payment?.entity;
  const claim = await claimedDeal(webhook, deps.razorpay);
  if (!claim) return undefined;

  if (!(await isRecordedLink(claim.dealId, link?.id, payment?.order_id, deps))) {
    const what = link ? `link ${link.id}` : `the link behind order ${payment?.order_id ?? "(none)"}`;
    console.warn(
      `[webhook] Ignoring ${webhook.event}: notes name deal ${claim.dealId}, but ${what} is not one this service recorded for it`,
    );
    return undefined;
  }
  return claim;
}

/** Step 1: the deal ID the notes claim, unverified. */
async function claimedDeal(
  webhook: RazorpayWebhook,
  razorpay: Pick<RazorpayClient, "fetchOrder">,
): Promise<ResolvedDeal | undefined> {
  const link = webhook.payload.payment_link?.entity;
  const payment = webhook.payload.payment?.entity;
  const order = webhook.payload.order?.entity;

  const fromNotes = (notes: Record<string, string> | undefined) => validDealId(notes?.bitrix_deal_id);

  const candidates: [string, string | undefined][] = [
    ["payment_link.notes", fromNotes(link?.notes)],
    ["payment.notes", fromNotes(payment?.notes)],
    ["order.notes", fromNotes(order?.notes)],
  ];
  for (const [source, dealId] of candidates) {
    if (dealId) return { dealId, source };
  }

  // Last resort: ask Razorpay for the order behind this payment.
  if (payment?.order_id) {
    try {
      const fetched = await razorpay.fetchOrder(payment.order_id);
      const notes = fetched.notes && !Array.isArray(fetched.notes) ? fetched.notes : undefined;
      const dealId = fromNotes(notes);
      if (dealId) return { dealId, source: "fetched order.notes" };
    } catch (err) {
      console.warn(`[webhook] Could not fetch order ${payment.order_id} to find the deal: ${(err as Error).message}`);
    }
  }
  return undefined;
}

/**
 * Step 2: is the event's link one this service recorded for `dealId`?
 *
 * payment_link.* events name their link. payment.failed doesn't, only its
 * order, so we fetch the deal's recorded links from Razorpay and compare orders.
 * Any lookup failure counts as "no": better a missing comment than one on the
 * wrong deal.
 */
async function isRecordedLink(
  dealId: string,
  linkId: string | undefined,
  orderId: string | null | undefined,
  deps: DealLookupDeps,
): Promise<boolean> {
  let deal;
  try {
    deal = await deps.bitrix.getDeal(dealId);
  } catch (err) {
    console.warn(`[webhook] Could not load deal ${dealId} to check its payment link: ${(err as Error).message}`);
    return false;
  }
  let unresolved: string | undefined;
  try {
    unresolved = await deps.unresolvedLinks.get(dealId);
  } catch (err) {
    // Storage unreachable: judge by the deal's field alone. A payment on an
    // unsaved link then gets no comment, which is safer than guessing.
    console.warn(`[webhook] Could not read the unresolved link of deal ${dealId}: ${(err as Error).message}`);
  }
  const recorded = [String(deal[deps.linkIdField] ?? "").trim(), unresolved].filter((id): id is string => !!id);

  if (linkId) return recorded.includes(linkId);
  if (!orderId) return false;
  for (const id of recorded) {
    try {
      if ((await deps.razorpay.fetchPaymentLink(id)).order_id === orderId) return true;
    } catch (err) {
      console.warn(`[webhook] Could not fetch link ${id} of deal ${dealId}: ${(err as Error).message}`);
    }
  }
  return false;
}

function validDealId(value: string | undefined): string | undefined {
  return value && /^\d+$/.test(value) ? value : undefined;
}

// =========================================================================== 4. comment text

/**
 * Turn a webhook into the timeline comment the sales team will read.
 * Returns undefined for events we don't comment on.
 *
 * Plain text only, no emoji. WHY: some Bitrix24 installs (especially older
 * self-hosted ones) store text in a MySQL charset that can't hold emoji. The
 * comment would fail or be cut off at the first emoji.
 */
export function buildComment(webhook: RazorpayWebhook): string | undefined {
  const link = webhook.payload.payment_link?.entity;
  const payment = webhook.payload.payment?.entity;
  const currency = link?.currency ?? payment?.currency ?? "INR";
  const money = (paise: number | undefined) => (paise === undefined ? "unknown amount" : formatMoney(paise, currency));

  // Build the comment as a list of lines and drop the ones we have no data for.
  const lines = (...items: (string | false | undefined | null)[]) =>
    items.filter((line): line is string => typeof line === "string" && line !== "").join("\n");

  const linkLine = link && `Payment link: ${link.short_url ?? link.id} (${link.id})`;
  const methodLine = payment?.method && `Method: ${payment.method}`;

  switch (webhook.event) {
    case "payment_link.paid": {
      // If the customer paid in several parts, the last payment is smaller than
      // the total, so show both.
      const total = link?.amount_paid ?? link?.amount ?? payment?.amount;
      const isFinalPart = payment?.amount !== undefined && total !== undefined && payment.amount !== total;
      return lines(
        "Razorpay: Payment successful",
        `Amount paid: ${money(total)}`,
        isFinalPart && `This payment: ${money(payment?.amount)} (final part of a partial payment)`,
        payment && `Payment ID: ${payment.id}`,
        methodLine,
        linkLine,
      );
    }

    case "payment_link.partially_paid": {
      const due = link?.amount;
      const paid = link?.amount_paid;
      const remaining = due !== undefined && paid !== undefined ? due - paid : undefined;
      return lines(
        "Razorpay: Partial payment received",
        `Paid so far: ${money(paid)} of ${money(due)}`,
        `Still due: ${money(remaining)}`,
        payment && `This payment: ${money(payment.amount)} (Payment ID: ${payment.id})`,
        methodLine,
        linkLine,
      );
    }

    case "payment_link.expired": {
      const paid = link?.amount_paid ?? 0;
      return lines(
        paid > 0
          ? `Razorpay: Payment link expired with only ${money(paid)} of ${money(link?.amount)} paid`
          : "Razorpay: Payment link expired unpaid",
        paid === 0 && `Amount due: ${money(link?.amount)}`,
        linkLine,
        "The customer can no longer use this link. Create a new one if they still want to pay.",
      );
    }

    case "payment_link.cancelled":
      return lines(
        "Razorpay: Payment link cancelled",
        `Amount: ${money(link?.amount)}`,
        linkLine,
        "The customer can no longer use this link.",
      );

    case "payment.failed": {
      // error_description is written for humans ("Your payment has been declined
      // by the bank"); error_reason is a short code ("payment_declined").
      const reason = payment?.error_description ?? payment?.error_reason ?? "No reason given";
      return lines(
        "Razorpay: Payment attempt failed",
        `Amount: ${money(payment?.amount)}`,
        `Reason: ${reason}${payment?.error_reason && payment.error_description ? ` (${payment.error_reason})` : ""}`,
        payment && `Payment ID: ${payment.id}`,
        methodLine,
        // Not final: the link stays active, and failed attempts are common
        // (wrong OTP, UPI timeout...). Say so, or sales may chase a customer
        // who already paid on their second try.
        "This is not final. The link is still active and the customer can retry with it.",
      );
    }

    default:
      return undefined;
  }
}

// =========================================================================== 5. process

export interface WebhookDeps extends DealLookupDeps {
  // Pick<> lists exactly the methods we use, so tests can pass a small fake
  // object instead of a real client.
  bitrix: Pick<BitrixClient, "safeComment" | "getDeal" | "moveDealToWon">;
  moveDealToWon: boolean;
}

export type ProcessOutcome =
  | { status: "ignored"; reason: string }
  | { status: "no_deal" }
  | { status: "done"; dealId: string; commented: boolean; movedToWon?: boolean };

/**
 * Act on one verified, de-duplicated webhook.
 *
 * NEVER THROWS. This runs after we've already answered Razorpay with 200, so
 * there's nobody to report an error to except the logs, and the deal timeline
 * where possible. An uncaught error here would be an "unhandled rejection",
 * which by default crashes the whole Node process.
 */
export async function processWebhook(webhook: RazorpayWebhook, deps: WebhookDeps): Promise<ProcessOutcome> {
  try {
    if (!isHandledEvent(webhook.event)) {
      console.info(`[webhook] Ignoring event ${webhook.event}`);
      return { status: "ignored", reason: `unhandled event ${webhook.event}` };
    }

    const resolved = await resolveDealId(webhook, deps);
    if (!resolved) {
      console.info(`[webhook] ${webhook.event}: no Bitrix deal linked to this payment, skipping`);
      return { status: "no_deal" };
    }
    const { dealId } = resolved;
    console.info(`[webhook] ${webhook.event} -> deal ${dealId} (found via ${resolved.source})`);

    const comment = buildComment(webhook);
    // safeComment logs its own failures (e.g. Bitrix down, or the deal was deleted).
    const commented = comment ? await deps.bitrix.safeComment(dealId, comment) : false;

    if (webhook.event !== "payment_link.paid" || !deps.moveDealToWon) {
      return { status: "done", dealId, commented };
    }

    // Optional: move the deal to Won. We fetch the deal to learn its pipeline,
    // because the Won stage ID differs per pipeline ("WON" vs "C3:WON").
    try {
      const deal = await deps.bitrix.getDeal(dealId);
      await deps.bitrix.moveDealToWon(dealId, String(deal.CATEGORY_ID ?? "0"));
      console.info(`[webhook] Deal ${dealId} moved to Won`);
      return { status: "done", dealId, commented, movedToWon: true };
    } catch (err) {
      // The payment itself succeeded, so this is a warning for the sales
      // team, not a payment problem.
      console.error(`[webhook] Deal ${dealId}: could not move to Won`, err);
      await deps.bitrix.safeComment(
        dealId,
        `Payment received, but the deal could not be moved to Won automatically: ${(err as Error).message}\n` +
          "Please move it manually.",
      );
      return { status: "done", dealId, commented, movedToWon: false };
    }
  } catch (err) {
    // A bug in our own code. Log everything; there's no deal we can safely blame.
    console.error(`[webhook] Unexpected error while processing ${webhook.event}`, err);
    return { status: "ignored", reason: `internal error: ${(err as Error).message}` };
  }
}

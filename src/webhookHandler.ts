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
 * everything. It's deliberately simple: fine for one server instance. If you
 * run several instances, move this into a shared database or Redis.
 *
 * The oldest entries are dropped after `maxEntries`. Razorpay only retries for
 * about 24 hours, so very old IDs are no longer needed.
 */
export class ProcessedEventStore {
  // A Map remembers insertion order, so the first key is always the oldest.
  private readonly seen = new Map<string, string>(); // event id -> ISO time processed
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
   * Record an event ID. Returns true if it's new (process it), false if it's a
   * duplicate (skip it).
   *
   * WHY check and record in one step: Razorpay can send the same event twice
   * almost at once. Because Node runs our code on one thread, the check and the
   * record below happen with nothing in between (there's no `await` between
   * them), so two simultaneous deliveries can't both see "new".
   */
  claim(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, new Date().toISOString());
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    this.persist();
    return true;
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /** Resolves once every save started so far has finished. Handy for tests and shutdown. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  /**
   * Save to disk in the background.
   *
   * Saves are chained one after another so two writes never overlap and
   * interleave. Each one writes a temp file and renames it over the real file,
   * so a crash mid-write can't leave a half-written, corrupt file.
   */
  private persist(): void {
    const snapshot = JSON.stringify([...this.seen.entries()]);
    this.writeChain = this.writeChain
      .then(async () => {
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
      })
      .catch((err) => console.error(`[webhook] Could not save processed events to ${this.path}`, err));
  }
}

// =========================================================================== 3. which deal?

export interface ResolvedDeal {
  dealId: string;
  /** Where we found it; logged to help debug unexpected payloads. */
  source: string;
}

/**
 * Work out which Bitrix deal a webhook belongs to, trying the most reliable
 * place first:
 *
 *   1. payment_link.notes.bitrix_deal_id  we put it there when creating the link
 *   2. payment_link.reference_id          "42" or "42-2": take the part before "-"
 *   3. payment.notes.bitrix_deal_id       for payment.failed, which has no payment_link
 *   4. order.notes.bitrix_deal_id         if the order came with the payload
 *   5. GET /orders/{order_id}             last resort for payment.failed: ask Razorpay
 *
 * Returns undefined if none of them work. That's normal for payment.failed
 * events from payments that have nothing to do with our links (e.g. your
 * website's checkout), because Razorpay sends payment.failed for every payment
 * on the account.
 */
export async function resolveDealId(
  webhook: RazorpayWebhook,
  razorpay: Pick<RazorpayClient, "fetchOrder">,
): Promise<ResolvedDeal | undefined> {
  const link = webhook.payload.payment_link?.entity;
  const payment = webhook.payload.payment?.entity;
  const order = webhook.payload.order?.entity;

  const fromNotes = (notes: Record<string, string> | undefined) => validDealId(notes?.bitrix_deal_id);

  const candidates: [string, string | undefined][] = [
    ["payment_link.notes", fromNotes(link?.notes)],
    // Only a reference like "42" or "42-3" counts. A link someone created by
    // hand in the dashboard with reference "INV-001" must not map to a deal.
    ["payment_link.reference_id", /^\d+(-\d+)?$/.test(link?.reference_id ?? "") ? link?.reference_id?.split("-")[0] : undefined],
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

export interface WebhookDeps {
  // Pick<> lists exactly the methods we use, so tests can pass a small fake
  // object instead of a real client.
  bitrix: Pick<BitrixClient, "safeComment" | "getDeal" | "moveDealToWon">;
  razorpay: Pick<RazorpayClient, "fetchOrder">;
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

    const resolved = await resolveDealId(webhook, deps.razorpay);
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

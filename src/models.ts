/**
 * The shapes of data coming into and going out of this service, as zod schemas.
 *
 * WHY zod schemas and not just TypeScript interfaces?
 *   TypeScript types disappear when the code runs; they only check *our* code.
 *   Data arriving over HTTP (from Bitrix or Razorpay) can be anything, so we
 *   need a check at runtime too. A zod schema does both jobs: it validates the
 *   data at runtime, and `z.infer<typeof Schema>` gives us the matching
 *   TypeScript type for free, so the two can never drift apart.
 *
 * Naming: incoming data is validated with a schema; outgoing responses are
 * built by our own code, so they only need a plain TypeScript type.
 */

import { z } from "zod";

// =========================================================================== Flow 1: create a link

/**
 * A Bitrix deal ID: digits only.
 *
 * Accepts a number (42) or a string ("42", " 42 "), and also "DEAL_42", which is
 * how Bitrix business processes name a deal document.
 */
export const DealIdSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim().replace(/^DEAL_/i, ""))
  .pipe(z.string().regex(/^\d+$/, "deal_id must be a numeric Bitrix24 deal ID"));

/**
 * Pull the deal ID out of an incoming create-link request.
 *
 * WHY look in several places: Bitrix can call us in different ways, and each
 * one puts the ID somewhere else:
 *   - Automation rule "Webhook" robot:  POST /payment-links?deal_id={{ID}}   (query string)
 *   - Your own scripts / curl / Postman: {"deal_id": 42}                      (JSON body)
 *   - Business process webhook:         document_id[2]=DEAL_42               (form body)
 * We check them in that order and use the first one found.
 */
export function extractDealId(query: unknown, body: unknown): string {
  const q = asRecord(query);
  const b = asRecord(body);
  const documentId = b.document_id;

  const candidate =
    q.deal_id ??
    q.id ??
    b.deal_id ??
    b.dealId ??
    b.id ??
    // Form fields named document_id[0], document_id[1], document_id[2]. The
    // third item is the document itself: "DEAL_42". With
    // express.urlencoded({ extended: true }) they arrive as an array; with the
    // default (extended: false) they arrive as a literal "document_id[2]" key.
    (Array.isArray(documentId) ? documentId[2] : undefined) ??
    b["document_id[2]"];

  if (candidate === undefined || candidate === "") {
    throw new RequestValidationError("deal_id is required (as ?deal_id=..., or in the JSON/form body)");
  }
  const result = DealIdSchema.safeParse(candidate);
  if (!result.success) {
    throw new RequestValidationError(result.error.issues[0]?.message ?? "invalid deal_id");
  }
  return result.data;
}

/** Thrown when an incoming request is malformed. The route turns it into HTTP 400. */
export class RequestValidationError extends Error {
  override name = "RequestValidationError";
}

/** Successful response from POST /payment-links. */
export interface CreateLinkResponse {
  status: "created";
  deal_id: string;
  payment_link_id: string; // plink_...
  short_url: string;
  reference_id: string; // "42", or "42-2" etc. if the deal had links before
  amount: number; // paise
  amount_display: string; // "₹1,499.99"
  currency: string;
  /**
   * false if the link was created in Razorpay but writing it back onto the deal
   * failed. The link still works; the timeline comment includes it so it isn't lost.
   */
  deal_updated: boolean;
}

/**
 * Machine-readable error codes for the create-link endpoint.
 * `as const` makes TypeScript treat these as exact string values rather than
 * just `string`, so a typo in an error code is a compile error.
 */
export const ErrorCodes = [
  "BAD_REQUEST", // missing or invalid deal_id, malformed JSON
  "UNAUTHORIZED", // wrong or missing ?token=
  "INVALID_SIGNATURE", // webhook signature check failed
  "NOT_FOUND", // no such route
  "ALREADY_IN_PROGRESS", // a link for this deal is being created right now (double click)
  "DEAL_NOT_FOUND",
  "INVALID_AMOUNT", // no amount, zero or negative
  "RAZORPAY_REJECTED", // Razorpay said no: bad amount, invalid customer data, auth failure
  "RAZORPAY_UNAVAILABLE", // couldn't reach Razorpay
  "BITRIX_ERROR", // Bitrix answered with an error
  "BITRIX_UNAVAILABLE", // couldn't reach Bitrix
  "INTERNAL_ERROR", // a bug in our code
] as const;
export type ErrorCode = (typeof ErrorCodes)[number];

/** Error response body, shared by all endpoints. */
export interface ErrorResponse {
  status: "error";
  error_code: ErrorCode;
  message: string;
  deal_id?: string;
}

// =========================================================================== Flow 2: Razorpay webhooks

/**
 * Razorpay's `notes` field, normalised to a plain object.
 *
 * GOTCHA: when there are no notes, Razorpay sends `[]` (an empty array) instead
 * of `{}`. That's an artifact of their PHP backend, where empty arrays and empty
 * objects are the same thing. Normalising here means the rest of the code can
 * always write `notes.bitrix_deal_id` safely.
 */
const NotesSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .nullish()
  .transform((notes): Record<string, string> => {
    if (!notes || Array.isArray(notes)) return {};
    return Object.fromEntries(Object.entries(notes).map(([key, value]) => [key, String(value)]));
  });

/*
 * The schemas below use z.looseObject: unknown extra fields are kept, not
 * rejected. WHY: Razorpay adds new fields to its payloads over time. A strict
 * schema would start rejecting real webhooks the day they add one. We only
 * declare the fields we actually read, and most are optional, because a
 * missing optional field should mean "skip that detail", not "drop the event".
 */

/** The payment link object, present in payload.payment_link.entity for payment_link.* events. */
export const PaymentLinkEntitySchema = z.looseObject({
  id: z.string(), // plink_...
  amount: z.number().optional(), // paise
  amount_paid: z.number().optional(), // paise
  currency: z.string().optional(),
  status: z.string().optional(),
  reference_id: z.string().nullish(),
  short_url: z.string().nullish(),
  notes: NotesSchema,
});

/** A single payment attempt, present in payload.payment.entity. */
export const PaymentEntitySchema = z.looseObject({
  id: z.string(), // pay_...
  amount: z.number().optional(), // paise
  currency: z.string().optional(),
  status: z.string().optional(), // captured, failed, ...
  order_id: z.string().nullish(),
  method: z.string().nullish(), // card, upi, netbanking, ...
  notes: NotesSchema,
  // Only filled in on failed payments:
  error_code: z.string().nullish(),
  error_description: z.string().nullish(), // human-readable, e.g. "Your payment has been declined by the bank"
  error_reason: z.string().nullish(), // machine-readable, e.g. "payment_declined"
  error_source: z.string().nullish(), // who failed: customer, bank, gateway...
});

/** The order behind a payment link (every link creates one), in payload.order.entity. */
export const OrderEntitySchema = z.looseObject({
  id: z.string(),
  receipt: z.string().nullish(),
  notes: NotesSchema,
});

/**
 * The outer envelope of every Razorpay webhook:
 *   {
 *     "entity": "event",
 *     "event": "payment_link.paid",
 *     "contains": ["payment_link", "order", "payment"],
 *     "payload": { "payment_link": {"entity": {...}}, "payment": {"entity": {...}}, ... },
 *     "created_at": 1727000000
 *   }
 * Each entity is wrapped in {"entity": ...}, which is why the schema has that
 * extra level.
 */
export const RazorpayWebhookSchema = z.looseObject({
  event: z.string(),
  account_id: z.string().optional(),
  created_at: z.number().optional(), // Unix seconds
  payload: z
    .looseObject({
      payment_link: z.object({ entity: PaymentLinkEntitySchema }).optional(),
      payment: z.object({ entity: PaymentEntitySchema }).optional(),
      order: z.object({ entity: OrderEntitySchema }).optional(),
    })
    .default({}),
});

export type RazorpayWebhook = z.infer<typeof RazorpayWebhookSchema>;
export type PaymentLinkEntity = z.infer<typeof PaymentLinkEntitySchema>;
export type PaymentEntity = z.infer<typeof PaymentEntitySchema>;
export type OrderEntity = z.infer<typeof OrderEntitySchema>;

/** The five webhook events we act on. Any others are acknowledged and ignored. */
export const HandledEvents = [
  "payment_link.paid",
  "payment_link.partially_paid",
  "payment_link.expired",
  "payment_link.cancelled",
  "payment.failed",
] as const;
export type HandledEvent = (typeof HandledEvents)[number];

export function isHandledEvent(event: string): event is HandledEvent {
  return (HandledEvents as readonly string[]).includes(event);
}

/**
 * What we answer to Razorpay. It ignores the body (any 2xx means "delivered");
 * the status is here for us, when reading logs or testing with curl.
 */
export interface WebhookAck {
  status: "accepted" | "duplicate" | "ignored";
}

// =========================================================================== misc

export interface HealthResponse {
  status: "ok";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

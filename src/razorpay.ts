/**
 * All communication with the Razorpay API lives here.
 *
 * AUTHENTICATION
 *   Razorpay uses HTTP Basic auth: username = key id (rzp_test_...), password =
 *   key secret. Test keys only ever touch test data (no real money moves), so the
 *   code is identical in test and live mode; only the keys change.
 *
 * ERRORS
 *   Unlike Bitrix, Razorpay uses HTTP status codes properly: 2xx means success,
 *   4xx/5xx means failure, with a body like
 *       {"error": {"code": "BAD_REQUEST_ERROR",
 *                  "description": "The amount must be atleast INR 1.00",
 *                  "field": "amount", ...}}
 *   The `description` is written for humans, so we put it straight into the
 *   Bitrix timeline comment for the sales team.
 *
 *   RazorpayError                  base class
 *   ├── RazorpayUnavailableError   network down, timeout, non-JSON 5xx
 *   └── RazorpayApiError           Razorpay answered with an error (bad amount, auth failure...)
 *       └── DuplicateReferenceError  this reference_id was already used for another link
 */

import Big from "big.js";

const API_BASE = "https://api.razorpay.com/v1";

// --------------------------------------------------------------------------- errors

export class RazorpayError extends Error {
  override name = "RazorpayError";
}

export class RazorpayUnavailableError extends RazorpayError {
  override name = "RazorpayUnavailableError";
}

export class RazorpayApiError extends RazorpayError {
  override name = "RazorpayApiError";
  readonly status: number;
  readonly code: string;
  readonly description: string;
  /** Which request field Razorpay complained about, e.g. "amount" or "customer.email". */
  readonly field: string | undefined;

  constructor(status: number, code: string, description: string, field?: string) {
    super(`Razorpay HTTP ${status} ${code}: ${description}${field ? ` (field: ${field})` : ""}`);
    this.status = status;
    this.code = code;
    this.description = description;
    this.field = field;
  }

  /** True for 401: wrong key id/secret, or test keys mixed with live keys. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/** Razorpay refused because another payment link already uses this reference_id. */
export class DuplicateReferenceError extends RazorpayApiError {
  override name = "DuplicateReferenceError";
}

/** The amount can't be turned into a valid payment (zero, negative, rounds to 0 paise...). */
export class InvalidAmountError extends Error {
  override name = "InvalidAmountError";
}

// --------------------------------------------------------------------------- types

export interface Customer {
  name?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
}

export interface CreatePaymentLinkInput {
  /** Amount in the currency's main unit (rupees), exactly as it comes from Bitrix. */
  amount: Big;
  currency: string;
  description: string;
  /** Bitrix deal ID. Used as the reference_id and stored in notes. */
  dealId: string;
  customer?: Customer | undefined;
  acceptPartial?: boolean;
  expireInDays?: number | undefined;
}

/** The fields we use from Razorpay's payment link object (it has many more). */
export interface PaymentLink {
  id: string; // "plink_..."
  short_url: string; // "https://rzp.io/rzp/abc123", the link the customer opens
  amount: number; // paise
  amount_paid: number; // paise
  currency: string;
  status: string; // created | partially_paid | paid | expired | cancelled
  reference_id: string;
  /** The order behind the link; payments on the link belong to it. */
  order_id?: string | null;
  notes: Record<string, string> | [] | null;
}

/** The fields we use from a Razorpay order (fallback lookup for payment.failed). */
export interface RazorpayOrder {
  id: string;
  receipt: string | null;
  notes: Record<string, string> | [] | null;
}

export interface RazorpayClientOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

// --------------------------------------------------------------------------- client

export class RazorpayClient {
  /** How many reference_id suffixes to try before giving up ("123", "123-2" ... "123-10"). */
  static readonly MAX_REFERENCE_ATTEMPTS = 10;

  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(keyId: string, keySecret: string, options: RazorpayClientOptions = {}) {
    // Basic auth header = "Basic " + base64("key_id:key_secret").
    this.authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  // ------------------------------------------------------------------ core request

  /**
   * Send one request to Razorpay and return the parsed JSON body.
   *
   * No automatic retries here. WHY: creating a payment link is not idempotent. If
   * the request timed out, Razorpay may still have created the link, and a blind
   * retry could create a second one. It's better to report the failure and let a
   * human look.
   */
  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : String(err);
      throw new RazorpayUnavailableError(`${method} ${path}: request to Razorpay failed: ${reason}`, { cause: err });
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RazorpayUnavailableError(
        `${method} ${path}: Razorpay returned HTTP ${response.status} with a non-JSON body: ${JSON.stringify(text.replace(/\s+/g, " ").slice(0, 200))}`,
      );
    }

    if (!response.ok) {
      throw toApiError(response.status, parsed);
    }
    return parsed as T;
  }

  // ------------------------------------------------------------------ payment links

  /**
   * Create one payment link with exactly the given reference_id.
   *
   * See createPaymentLinkForDeal for the version that handles "this deal already
   * had a link" by picking the next free reference_id.
   */
  async createPaymentLink(input: CreatePaymentLinkInput, referenceId: string): Promise<PaymentLink> {
    return this.request<PaymentLink>("POST", "/payment_links", buildPaymentLinkPayload(input, referenceId));
  }

  /**
   * Create a payment link for a deal, choosing the first free reference_id.
   *
   * WHY the retry loop: Razorpay refuses a reference_id that another link is
   * still using. The first link for deal 123 gets "123"; if that's taken we try
   * "123-2", "123-3"... The reference is only a label the customer sees as
   * "RECEIPT"; payments are matched to deals by notes.bitrix_deal_id (checked
   * against the deal's saved Link ID), never by reference.
   *
   * Seen in test mode: a CANCELLED link frees its reference_id, so it can be
   * reused. Two links can therefore share "123-2", but only one of them can
   * still be paid. That's harmless: payments aren't matched by reference.
   *
   * Only DuplicateReferenceError triggers a retry. Any other error (bad amount,
   * auth failure, network) is thrown straight away.
   */
  async createPaymentLinkForDeal(input: CreatePaymentLinkInput): Promise<PaymentLink> {
    for (let attempt = 1; attempt <= RazorpayClient.MAX_REFERENCE_ATTEMPTS; attempt++) {
      const referenceId = attempt === 1 ? input.dealId : `${input.dealId}-${attempt}`;
      try {
        return await this.createPaymentLink(input, referenceId);
      } catch (err) {
        if (!(err instanceof DuplicateReferenceError)) throw err;
        console.info(`[razorpay] reference_id ${referenceId} already used, trying the next suffix`);
      }
    }
    throw new RazorpayApiError(
      400,
      "TOO_MANY_LINKS",
      `Deal ${input.dealId} already has ${RazorpayClient.MAX_REFERENCE_ATTEMPTS} payment links. ` +
        "Cancel old links in the Razorpay dashboard, or raise MAX_REFERENCE_ATTEMPTS.",
    );
  }

  /**
   * Fetch an order by id.
   *
   * Used when handling payment.failed: that webhook contains the payment and its
   * order_id, but not always the payment link, so the order is a second place to
   * look for our bitrix_deal_id note.
   */
  async fetchOrder(orderId: string): Promise<RazorpayOrder> {
    return this.request<RazorpayOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
  }

  /** Fetch a payment link by id, e.g. to check whether it has been paid. */
  async fetchPaymentLink(linkId: string): Promise<PaymentLink> {
    return this.request<PaymentLink>("GET", `/payment_links/${encodeURIComponent(linkId)}`);
  }

  /**
   * Cancel a payment link so the customer can no longer pay with it.
   * Razorpay only allows this for links that aren't paid, expired or already
   * cancelled; otherwise it answers with an error.
   */
  async cancelPaymentLink(linkId: string): Promise<PaymentLink> {
    return this.request<PaymentLink>("POST", `/payment_links/${encodeURIComponent(linkId)}/cancel`);
  }

  /**
   * Check that the API keys work by making a harmless read-only request (list
   * one order). Throws RazorpayApiError with isAuthError=true if the keys are wrong.
   */
  async verifyCredentials(): Promise<void> {
    await this.request("GET", "/orders?count=1");
  }
}

/**
 * Build the JSON body for POST /payment_links.
 *
 * A separate function (not buried inside createPaymentLink) so it can be tested,
 * and previewed by `npm run check-setup` without creating anything.
 */
export function buildPaymentLinkPayload(input: CreatePaymentLinkInput, referenceId: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    amount: toPaise(input.amount), // Razorpay wants the smallest unit: 1499.99 INR -> 149999 paise
    currency: input.currency,
    description: input.description.slice(0, 2048), // Razorpay's max length
    // reference_id: shown to the customer as "RECEIPT" and searchable in the
    // dashboard. Razorpay refuses one that an active link already uses, which
    // also stops two links being created in a race.
    reference_id: referenceId,
    // We send the link to the customer ourselves (e.g. from Bitrix), so stop
    // Razorpay from also sending its own SMS/email.
    notify: { sms: false, email: false },
    reminder_enable: false,
    // notes are free-form key/value pairs that Razorpay echoes back in every
    // webhook for this link. The webhook handler uses the deal ID here to find
    // the deal, then checks the deal's saved Link ID really is this link before
    // acting, so notes copied onto another link or payment don't count.
    notes: { bitrix_deal_id: input.dealId },
    accept_partial: input.acceptPartial ?? false,
  };

  const customer = buildCustomer(input.customer);
  if (customer) payload.customer = customer;

  if (input.expireInDays) {
    // expire_by is a Unix timestamp in seconds (not milliseconds).
    payload.expire_by = Math.floor(Date.now() / 1000) + input.expireInDays * 24 * 60 * 60;
  }
  return payload;
}

// --------------------------------------------------------------------------- money helpers

/**
 * Convert an amount in rupees to paise (an integer), exactly.
 *
 * WHY big.js: with plain numbers, 1.005 * 100 === 100.49999999999999, which rounds
 * to 100 instead of 101. Big does decimal arithmetic, so the result is exact.
 * Rounding is "half up" (0.005 -> 0.01), the way people round money by hand.
 *
 * Note: "multiply by 100" is right for INR and most currencies (2 decimal
 * places). A few currencies use 0 (JPY) or 3 (KWD, BHD) decimal places. Extend
 * this before accepting those.
 */
export function toPaise(amount: Big): number {
  if (amount.lte(0)) {
    throw new InvalidAmountError(`Amount must be greater than zero (got ${amount.toString()})`);
  }
  const paise = amount.times(100).round(0, Big.roundHalfUp);
  if (paise.lte(0)) {
    throw new InvalidAmountError(`Amount ${amount.toString()} is too small to charge (rounds to 0 paise)`);
  }
  const result = paise.toNumber();
  if (!Number.isSafeInteger(result)) {
    throw new InvalidAmountError(`Amount ${amount.toString()} is too large`);
  }
  return result;
}

/**
 * Format an amount in paise for humans, e.g. 149999 INR -> "₹1,499.99".
 * Used in timeline comments, so the sales team sees normal money, not paise.
 */
export function formatMoney(paise: number, currency: string): string {
  const major = paise / 100; // fine for display: we never do arithmetic with this
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(major);
  } catch {
    // Intl throws RangeError for malformed currency codes (e.g. "RUPEE", "rs").
    // A well-formed but unknown code like "XYZ" doesn't throw; it's printed as-is.
    return `${currency} ${major.toFixed(2)}`;
  }
}

// --------------------------------------------------------------------------- internal helpers

/**
 * Build Razorpay's `customer` object, leaving out empty values.
 *
 * WHY leave them out: Razorpay validates every field it receives. An empty
 * string for email is "invalid email", while a missing email is fine.
 */
function buildCustomer(customer: Customer | undefined): Record<string, string> | undefined {
  if (!customer) return undefined;
  const result: Record<string, string> = {};
  if (customer.name) result.name = customer.name;
  if (customer.email) result.email = customer.email;
  // Bitrix phones are free text ("+91 98765-43210", "(022) 1234 5678"). Razorpay
  // wants digits with an optional leading "+", so remove spaces, dashes, dots
  // and brackets.
  const phone = customer.phone?.replace(/[\s\-().]/g, "");
  if (phone) result.contact = phone;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Turn Razorpay's error JSON into the right error class. */
function toApiError(status: number, body: unknown): RazorpayApiError {
  const error = (body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const code = String(error.code ?? "UNKNOWN_ERROR");
  const description = String(error.description ?? "Razorpay returned an error without a description");
  const field = typeof error.field === "string" && error.field !== "" ? error.field : undefined;

  // Razorpay doesn't give duplicates their own error code: it's a
  // BAD_REQUEST_ERROR whose description says the reference id already exists.
  // We match on the wording loosely so small changes to the text don't break it.
  const text = description.toLowerCase();
  const isDuplicateReference =
    status === 400 &&
    (field === "reference_id" || /reference[\s_]?id/.test(text)) &&
    /(already|exist|duplicate|unique)/.test(text);

  return isDuplicateReference
    ? new DuplicateReferenceError(status, code, description, field)
    : new RazorpayApiError(status, code, description, field);
}

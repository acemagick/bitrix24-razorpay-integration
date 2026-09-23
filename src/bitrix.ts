/**
 * All communication with the Bitrix24 REST API lives here.
 *
 * HOW BITRIX24 INBOUND WEBHOOKS WORK
 *   An inbound webhook is a URL like
 *       https://portal.bitrix24.in/rest/1/abc123/
 *   where `1` is the user the calls run as and `abc123` is a secret token.
 *   You call a REST method by appending its name plus `.json`:
 *       POST https://portal.bitrix24.in/rest/1/abc123/crm.deal.get.json
 *       body: {"id": 42}
 *
 * WHY THE HTTP STATUS CODE IS NOT ENOUGH
 *   Bitrix24 reports many errors as JSON inside the response body, sometimes with
 *   HTTP 200 and sometimes with 400/401:
 *       {"error": "NOT_FOUND", "error_description": "Not found"}
 *   A successful call instead returns {"result": ..., "time": {...}}.
 *   So we always parse the body and check for an `error` key, whatever the status.
 *
 * ERROR TYPES (the rest of the app decides what to do with each one)
 *   BitrixError                 base class, so callers can catch "any Bitrix problem"
 *   ├── BitrixUnavailableError  network down, timeout, 5xx HTML page: we never got an answer
 *   └── BitrixApiError          Bitrix answered, but with an error
 *       └── DealNotFoundError   the specific "this deal doesn't exist" case
 */

import Big from "big.js";

// --------------------------------------------------------------------------- errors

/** Base class for every Bitrix24 failure. */
export class BitrixError extends Error {
  override name = "BitrixError";
}

/** We could not get a usable response: connection refused, timeout, 5xx HTML, etc. */
export class BitrixUnavailableError extends BitrixError {
  override name = "BitrixUnavailableError";
}

/** Bitrix24 responded, but the JSON body contained an `error` key. */
export class BitrixApiError extends BitrixError {
  override name = "BitrixApiError";
  readonly method: string;
  readonly code: string;
  readonly description: string;

  constructor(method: string, code: string, description: string) {
    super(`${method} failed: ${code || "ERROR"}: ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
  }
}

/** crm.deal.get said the deal doesn't exist (or we can't see it). */
export class DealNotFoundError extends BitrixApiError {
  override name = "DealNotFoundError";
}

// --------------------------------------------------------------------------- data

/** The parts of a Bitrix24 contact that Razorpay's `customer` object needs. */
export interface ContactInfo {
  name: string | undefined;
  email: string | undefined;
  phone: string | undefined;
}

/**
 * A trimmed-down deal holding only the fields this service uses.
 *
 * WHY not pass the raw object around: the raw Bitrix deal has ~50 keys, all
 * strings, with inconsistent empty values ("", null, "0"). We clean it up once,
 * here, and the rest of the code gets proper types.
 */
export interface DealInfo {
  id: string;
  title: string;
  /** undefined means "no usable amount on the deal". */
  amount: Big | undefined;
  currency: string;
  /** Pipeline ID; "0" is the default pipeline. */
  categoryId: string;
  contact: ContactInfo | undefined;
}

/** A raw Bitrix record: string keys, values of unknown shape. */
type BitrixRecord = Record<string, unknown>;

// --------------------------------------------------------------------------- client

export interface BitrixClientOptions {
  /** Per-request timeout. Bitrix is usually fast; 15s means something is wrong. */
  timeoutMs?: number;
  /** Injected so tests can pass a fake fetch instead of hitting a real portal. */
  fetchFn?: typeof fetch;
  /** Wait before the single retry. Tests set this to 0. */
  retryDelayMs?: number;
}

// Low-level network error codes meaning "the request never reached Bitrix".
// Only these are safe to retry for any method (see BitrixClient.call).
const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

// Bitrix24 allows roughly 2 requests/second per portal and answers
// QUERY_LIMIT_EXCEEDED when you go over. That's a "slow down", not a real error.
const RATE_LIMIT_CODE = "QUERY_LIMIT_EXCEEDED";

/**
 * A thin async wrapper over the Bitrix24 REST API.
 *
 * Uses Node's built-in `fetch`, which keeps a shared connection pool behind the
 * scenes, so repeated calls to the same portal reuse connections automatically.
 */
export class BitrixClient {
  private readonly webhookUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(webhookUrl: string, options: BitrixClientOptions = {}) {
    this.webhookUrl = webhookUrl.endsWith("/") ? webhookUrl : `${webhookUrl}/`;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  // ------------------------------------------------------------------ core call

  /**
   * Call a Bitrix24 REST method and return its `result` value.
   *
   * Retries once, but only for failures where the request provably did not
   * take effect:
   *   - QUERY_LIMIT_EXCEEDED: Bitrix rejected the call outright.
   *   - connection refused / DNS failure / connect timeout: the request never
   *     reached Bitrix.
   * We deliberately do NOT retry when the response timed out. For a write such
   * as "add comment", Bitrix may have done the work and only the reply was slow,
   * so retrying could post the same comment twice.
   */
  async call<T = unknown>(method: string, params: BitrixRecord = {}): Promise<T> {
    const url = `${this.webhookUrl}${method}.json`;
    const attempts = 2;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          // Without a timeout, a hung connection would hang our request forever.
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (isConnectError(err) && attempt < attempts) {
          console.warn(`[bitrix] ${method}: connection failed (${describe(err)}), retrying`);
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new BitrixUnavailableError(`${method}: request to Bitrix24 failed: ${describe(err)}`, { cause: err });
      }

      // Read the body BEFORE looking at the status code; Bitrix puts its error
      // details in the JSON even when the status is 400/401.
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON at all: usually a proxy/maintenance HTML page or a 502/503.
        throw new BitrixUnavailableError(
          `${method}: Bitrix24 returned HTTP ${response.status} with a non-JSON body: ${JSON.stringify(text.slice(0, 200))}`,
        );
      }

      if (!isRecord(body)) {
        throw new BitrixApiError(method, "UNEXPECTED_RESPONSE", `Expected a JSON object, got ${text.slice(0, 200)}`);
      }

      if ("error" in body) {
        const code = String(body.error ?? "");
        const description = String(body.error_description ?? "");
        if (code === RATE_LIMIT_CODE && attempt < attempts) {
          console.warn(`[bitrix] ${method}: rate limited, retrying in ${this.retryDelayMs}ms`);
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new BitrixApiError(method, code, description);
      }

      if (!response.ok || !("result" in body)) {
        // JSON without an `error` key but still unusable. Rare, but we don't want
        // to hand the caller a silent undefined.
        throw new BitrixApiError(method, `HTTP_${response.status}`, `Unexpected response: ${text.slice(0, 200)}`);
      }

      return body.result as T;
    }

    // Unreachable (the loop always returns or throws); keeps TypeScript happy.
    throw new BitrixUnavailableError(`${method}: retries exhausted`);
  }

  // ------------------------------------------------------------------ deals

  /**
   * Fetch the raw deal object via crm.deal.get.
   *
   * Converts Bitrix's "not found" errors into DealNotFoundError so callers can
   * tell "this deal doesn't exist" apart from "Bitrix is broken".
   */
  async getDeal(dealId: string | number): Promise<BitrixRecord> {
    let deal: unknown;
    try {
      deal = await this.call("crm.deal.get", { id: dealId });
    } catch (err) {
      // Depending on portal version, a missing deal comes back as
      // error="NOT_FOUND", or as error="" with description "Not found".
      if (
        err instanceof BitrixApiError &&
        (err.code === "NOT_FOUND" || err.description.toLowerCase().includes("not found"))
      ) {
        throw new DealNotFoundError(err.method, err.code || "NOT_FOUND", err.description);
      }
      throw err;
    }
    if (!isRecord(deal) || Object.keys(deal).length === 0) {
      throw new DealNotFoundError("crm.deal.get", "NOT_FOUND", `Deal ${dealId} returned an empty result`);
    }
    return deal;
  }

  /**
   * Fetch a contact and flatten it into the ContactInfo shape.
   *
   * WHY flatten: in Bitrix, EMAIL and PHONE are "multi-fields", i.e. arrays like
   *     [{"ID": "7", "VALUE": "a@b.com", "VALUE_TYPE": "WORK"}, ...]
   * because a contact can have several. Razorpay wants a single email and a
   * single phone, so we take the first non-empty one.
   */
  async getContact(contactId: string | number): Promise<ContactInfo> {
    const contact = await this.call<BitrixRecord>("crm.contact.get", { id: contactId });
    const name = [contact.NAME, contact.LAST_NAME]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ")
      .trim();
    return {
      name: name || undefined,
      email: firstMultiFieldValue(contact.EMAIL),
      phone: firstMultiFieldValue(contact.PHONE),
    };
  }

  /**
   * Fetch a deal plus its primary contact, and return a clean DealInfo.
   *
   * A failed contact lookup is logged and ignored instead of thrown.
   * WHY: the contact only pre-fills the customer's details on the Razorpay page.
   * A broken contact shouldn't stop us from creating a payment link.
   */
  async getDealWithContact(dealId: string | number): Promise<DealInfo> {
    const deal = await this.getDeal(dealId);

    let contact: ContactInfo | undefined;
    const contactId = deal.CONTACT_ID;
    // Bitrix uses null, "" or "0" for "no contact linked".
    if (contactId && String(contactId) !== "0") {
      try {
        contact = await this.getContact(String(contactId));
      } catch (err) {
        if (!(err instanceof BitrixError)) throw err; // a bug in our code: don't swallow it
        console.warn(`[bitrix] Deal ${dealId}: could not load contact ${String(contactId)}: ${err.message}`);
      }
    }

    return {
      id: String(deal.ID ?? dealId),
      title: nonEmptyString(deal.TITLE) ?? `Deal #${dealId}`,
      amount: parseAmount(deal.OPPORTUNITY),
      currency: (nonEmptyString(deal.CURRENCY_ID) ?? "INR").toUpperCase(),
      categoryId: nonEmptyString(deal.CATEGORY_ID) ?? "0",
      contact,
    };
  }

  /** Update deal fields via crm.deal.update (e.g. our two UF_CRM_ custom fields). */
  async updateDeal(dealId: string | number, fields: BitrixRecord): Promise<void> {
    await this.call("crm.deal.update", { id: dealId, fields });
  }

  /**
   * Move the deal to its pipeline's "Won" stage.
   *
   * WHY the category matters: stage IDs are namespaced by pipeline. The default
   * pipeline (category 0) uses plain "WON"; any other pipeline N uses "CN:WON".
   * Setting "WON" on a deal in pipeline 3 would fail or put it in the wrong stage.
   */
  async moveDealToWon(dealId: string | number, categoryId = "0"): Promise<void> {
    const stageId = categoryId === "" || categoryId === "0" ? "WON" : `C${categoryId}:WON`;
    await this.updateDeal(dealId, { STAGE_ID: stageId });
  }

  /** Return the deal field definitions (crm.deal.fields), including custom UF_CRM_ fields. */
  async listDealFields(): Promise<Record<string, BitrixRecord>> {
    return this.call<Record<string, BitrixRecord>>("crm.deal.fields");
  }

  // ------------------------------------------------------------------ timeline

  /** Post a comment on the deal's timeline (the activity feed the sales team sees). */
  async addTimelineComment(dealId: string | number, text: string): Promise<void> {
    await this.call("crm.timeline.comment.add", {
      fields: { ENTITY_ID: dealId, ENTITY_TYPE: "deal", COMMENT: text },
    });
  }

  /**
   * Post a timeline comment and never throw. Resolves to true if it was posted.
   *
   * WHY this exists: we use it inside error handlers. If Bitrix itself is the
   * thing that's broken, trying to report the error to Bitrix will fail too, and
   * that second failure must not crash the handler or hide the first error.
   * Logging is the fallback of last resort.
   */
  async safeComment(dealId: string | number, text: string): Promise<boolean> {
    try {
      await this.addTimelineComment(dealId, text);
      return true;
    } catch (err) {
      console.error(`[bitrix] Could not post timeline comment on deal ${dealId}. Comment was: ${text}`, err);
      return false;
    }
  }
}

// --------------------------------------------------------------------------- helpers

/** Return the first non-empty VALUE from a Bitrix multi-field array (EMAIL/PHONE). */
function firstMultiFieldValue(values: unknown): string | undefined {
  if (!Array.isArray(values)) return undefined;
  for (const item of values) {
    const value = isRecord(item) ? nonEmptyString(item.VALUE) : undefined;
    if (value) return value;
  }
  return undefined;
}

/**
 * Turn Bitrix's OPPORTUNITY (a string like "1500.00", or "" or null) into a Big.
 *
 * WHY Big and not a plain number: JavaScript numbers are binary floating point,
 * so most decimal fractions aren't exact (0.1 + 0.2 === 0.30000000000000004).
 * For money we want exact arithmetic, especially before multiplying by 100 to
 * get paise.
 *
 * Returns undefined when there is no parseable amount. Deciding whether zero or
 * a negative amount is acceptable is the caller's job, not the parser's.
 */
export function parseAmount(raw: unknown): Big | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  if (text === "") return undefined;
  try {
    return new Big(text); // throws on "abc", "NaN", "Infinity"
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

function isRecord(value: unknown): value is BitrixRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * fetch() throws a TypeError("fetch failed") whose `cause` holds the real
 * network error code. Check that code to see whether the connection was never
 * established (safe to retry) or failed midway (not safe).
 */
function isConnectError(err: unknown): boolean {
  const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
  return cause?.code !== undefined && CONNECT_ERROR_CODES.has(cause.code);
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError") return "timed out";
  const cause = err.cause as { code?: string; message?: string } | undefined;
  return cause?.code ? `${err.message} (${cause.code})` : err.message;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

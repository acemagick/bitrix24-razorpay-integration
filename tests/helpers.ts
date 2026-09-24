/**
 * Shared test helpers: fake Bitrix24 and Razorpay servers, a test config, and
 * temp folders.
 *
 * WHY FAKE SERVERS INSTEAD OF MOCKING OUR OWN CLASSES
 *   Both clients accept a `fetchFn` option. We give them a fake fetch that
 *   behaves like the real API: same URLs, same JSON shapes, same error formats
 *   (Bitrix's `{"error": ...}` bodies, Razorpay's 400s). So the tests run the
 *   REAL BitrixClient and RazorpayClient code: parsing, error classes, retries.
 *   Mocking the classes themselves would skip exactly the parts most likely to break.
 */

import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

import { BitrixClient } from "../src/bitrix.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { RazorpayClient } from "../src/razorpay.ts";

// --------------------------------------------------------------------------- basics

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A valid config for tests. Override any variable by its env name. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    BITRIX_WEBHOOK_URL: "https://portal.bitrix24.test/rest/1/secret/",
    BITRIX_PAYMENT_LINK_FIELD: "UF_CRM_LINK",
    BITRIX_PAYMENT_ID_FIELD: "UF_CRM_LINK_ID",
    RAZORPAY_KEY_ID: "rzp_test_abc123",
    RAZORPAY_KEY_SECRET: "key-secret",
    RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
    ...overrides,
  });
}

/**
 * A fresh temp folder, deleted automatically when the current test finishes.
 * Tests must await any background saves (store.flush()) before they end, or a
 * save can still be writing into the folder while it's being deleted.
 */
export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "b24rzp-test-"));
  // maxRetries: Windows can briefly keep a just-closed file locked.
  onTestFinished(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** Sign a webhook body the way Razorpay does. */
export const sign = (body: string, secret = "webhook-secret") => createHmac("sha256", secret).update(body).digest("hex");

// --------------------------------------------------------------------------- fake Bitrix24

type Responder = () => Response | Promise<Response>;

export interface BitrixCall {
  method: string; // e.g. "crm.deal.get"
  params: Record<string, any>;
}

/**
 * A fake Bitrix24 portal holding deals and contacts in memory.
 *
 *   const bitrix = createFakeBitrix();
 *   bitrix.deals.set("54", deal({ ID: "54" }));
 *   bitrix.failOn("crm.deal.update", () => json(400, { error: "ERROR_CORE", ... }));
 *   ... run code with bitrix.client ...
 *   bitrix.comments("54")   // timeline comments posted on deal 54
 */
export function createFakeBitrix() {
  const deals = new Map<string, Record<string, unknown>>();
  const contacts = new Map<string, Record<string, unknown>>();
  const calls: BitrixCall[] = [];
  const failures = new Map<string, Responder>();

  const fetchFn: typeof fetch = async (input, init) => {
    const method = String(input).split("/").pop()!.replace(/\.json$/, "");
    const params = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ method, params });

    const failure = failures.get(method);
    if (failure) return failure();

    switch (method) {
      case "crm.deal.get": {
        const found = deals.get(String(params.id));
        // Real Bitrix: HTTP 400 with an EMPTY error code for a missing deal.
        return found ? json(200, { result: found }) : json(400, { error: "", error_description: "Not found" });
      }
      case "crm.contact.get": {
        const found = contacts.get(String(params.id));
        return found ? json(200, { result: found }) : json(400, { error: "NOT_FOUND", error_description: "Not found" });
      }
      case "crm.deal.update": {
        const found = deals.get(String(params.id));
        if (found) Object.assign(found, params.fields);
        return json(200, { result: true });
      }
      case "crm.timeline.comment.add":
        return json(200, { result: calls.length });
      case "crm.deal.fields":
        return json(200, {
          result: {
            TITLE: { type: "string", title: "Name" },
            UF_CRM_LINK: { type: "string", listLabel: "Razorpay Payment Link" },
            UF_CRM_LINK_ID: { type: "string", formLabel: "Razorpay Link ID" },
          },
        });
      default:
        return json(400, { error: "ERROR_METHOD_NOT_FOUND", error_description: `Method not found: ${method}` });
    }
  };

  return {
    client: new BitrixClient("https://portal.bitrix24.test/rest/1/secret/", { fetchFn, retryDelayMs: 0 }),
    fetchFn,
    deals,
    contacts,
    calls,
    /** Make one REST method answer with `respond` instead of behaving normally. */
    failOn(method: string, respond: Responder) {
      failures.set(method, respond);
    },
    clearFailures() {
      failures.clear();
    },
    /** Timeline comments posted, optionally only those on one deal. */
    comments(dealId?: string): string[] {
      return calls
        .filter((c) => c.method === "crm.timeline.comment.add")
        .filter((c) => dealId === undefined || String(c.params.fields.ENTITY_ID) === dealId)
        .map((c) => String(c.params.fields.COMMENT));
    },
    callsTo(method: string): BitrixCall[] {
      return calls.filter((c) => c.method === method);
    },
  };
}

/** A realistic raw Bitrix deal. Amounts come back with 8 decimal places, like the real API. */
export function deal(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: "54",
    TITLE: "Website redesign",
    OPPORTUNITY: "11.80000000",
    CURRENCY_ID: "INR",
    CONTACT_ID: null,
    CATEGORY_ID: "0",
    STAGE_ID: "NEW",
    ...fields,
  };
}

// --------------------------------------------------------------------------- fake Razorpay

export interface FakeLink {
  id: string;
  short_url: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: string;
  reference_id: string;
  order_id?: string;
  notes: Record<string, string>;
  /** The request body that created this link (only for links created through the API). */
  request?: Record<string, any>;
}

/**
 * A fake Razorpay account holding payment links in memory. It enforces the rules
 * we rely on: a reference_id can't be reused while another link using it is
 * still active, and only unpaid ("created") links can be cancelled.
 *
 *   const rzp = createFakeRazorpay();
 *   rzp.addLink({ id: "plink_Old", status: "paid", ... });
 *   rzp.failOn("POST /payment_links", () => json(401, {...}));
 *   rzp.calls   // ["GET /payment_links/plink_Old", "POST /payment_links", ...]
 */
export function createFakeRazorpay() {
  const links = new Map<string, FakeLink>();
  const orders = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const failures = new Map<string, Responder>();
  const state = { latencyMs: 0, counter: 0 };

  const error = (status: number, description: string, field?: string) =>
    json(status, { error: { code: "BAD_REQUEST_ERROR", description, ...(field && { field }) } });

  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v1/, "");
    const httpMethod = init?.method ?? "GET";
    calls.push(`${httpMethod} ${path}`);
    if (state.latencyMs) await sleep(state.latencyMs);

    // Failure keys use ":id" in place of real IDs, e.g. "POST /payment_links/:id/cancel".
    const route = `${httpMethod} ${path.replace(/\/(plink|order)_\w+/, "/:id")}`;
    const failure = failures.get(route);
    if (failure) return failure();

    const id = path.split("/")[2] ?? "";
    switch (route) {
      case "POST /payment_links": {
        const body = JSON.parse(String(init?.body));
        const clash = [...links.values()].some((l) => l.reference_id === body.reference_id && l.status !== "cancelled");
        if (clash) return error(400, `Payment Link with reference id ${body.reference_id} already exists`, "reference_id");
        const n = ++state.counter;
        const link: FakeLink = {
          id: `plink_Fake${n}`,
          short_url: `https://rzp.io/rzp/fake${n}`,
          amount: body.amount,
          amount_paid: 0,
          currency: body.currency,
          status: "created",
          reference_id: body.reference_id,
          notes: body.notes,
          request: body,
        };
        links.set(link.id, link);
        return json(200, link);
      }
      case "GET /payment_links/:id": {
        const link = links.get(id);
        return link ? json(200, link) : error(400, "The id provided does not exist");
      }
      case "POST /payment_links/:id/cancel": {
        const link = links.get(id);
        if (!link) return error(400, "The id provided does not exist");
        if (link.status !== "created") return error(400, `Payment link cannot be cancelled as it is ${link.status}`);
        link.status = "cancelled";
        return json(200, link);
      }
      case "GET /orders/:id": {
        const order = orders.get(id);
        return order ? json(200, order) : error(400, "The id provided does not exist");
      }
      case "GET /orders":
        return json(200, { entity: "collection", count: 0, items: [] });
      default:
        return error(404, `No fake route for ${route}`);
    }
  };

  return {
    client: new RazorpayClient("rzp_test_abc123", "key-secret", { fetchFn }),
    fetchFn,
    links,
    orders,
    calls,
    /** Delay every response, to make concurrent requests overlap. */
    set latencyMs(ms: number) {
      state.latencyMs = ms;
    },
    failOn(route: string, respond: Responder) {
      failures.set(route, respond);
    },
    clearFailures() {
      failures.clear();
    },
    /** Put an existing link into the account (e.g. one created before the test). */
    addLink(link: Partial<FakeLink> & { id: string }): FakeLink {
      const full: FakeLink = {
        short_url: `https://rzp.io/rzp/${link.id}`,
        amount: 1180,
        amount_paid: 0,
        currency: "INR",
        status: "created",
        reference_id: "54",
        notes: { bitrix_deal_id: "54" },
        ...link,
      };
      links.set(full.id, full);
      return full;
    },
    created(): FakeLink[] {
      return [...links.values()].filter((l) => l.request);
    },
  };
}

// --------------------------------------------------------------------------- webhook payloads

/**
 * Build a Razorpay webhook body shaped like the real ones.
 * `entities` are the parts of `payload`, e.g. { payment_link: {...}, payment: {...} }.
 */
export function webhookBody(event: string, entities: Record<string, Record<string, unknown>> = {}): string {
  return JSON.stringify({
    entity: "event",
    account_id: "acc_Test",
    event,
    contains: Object.keys(entities),
    payload: Object.fromEntries(Object.entries(entities).map(([name, entity]) => [name, { entity }])),
    created_at: 1_727_000_000,
  });
}

export function linkEntity(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "plink_ABC",
    entity: "payment_link",
    amount: 149_999,
    amount_paid: 0,
    currency: "INR",
    status: "created",
    reference_id: "42",
    short_url: "https://rzp.io/rzp/abc",
    notes: { bitrix_deal_id: "42" },
    ...fields,
  };
}

export function paymentEntity(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pay_XYZ",
    entity: "payment",
    amount: 149_999,
    currency: "INR",
    status: "captured",
    order_id: "order_123",
    method: "upi",
    notes: [], // Razorpay sends [] (not {}) for "no notes"
    ...fields,
  };
}

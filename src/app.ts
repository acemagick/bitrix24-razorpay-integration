/**
 * The Express app: routes only. The real work lives in paymentLinks.ts (flow 1)
 * and webhookHandler.ts (flow 2).
 *
 *   GET  /health               is the service up?
 *   POST /payment-links        flow 1: create a payment link for a deal
 *   POST /webhooks/razorpay    flow 2: Razorpay tells us about payments
 *   GET  /bitrix/deal-fields   list custom deal fields (to find UF_CRM_ names)
 *
 * WHY createApp() takes its dependencies as a parameter: tests can pass fake
 * Bitrix/Razorpay clients and exercise every route without real accounts.
 * main.ts passes the real ones.
 */

import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";

import type { BitrixClient } from "./bitrix.ts";
import type { Config } from "./config.ts";
import {
  RazorpayWebhookSchema,
  RequestValidationError,
  extractDealId,
  isHandledEvent,
  type ErrorCode,
  type ErrorResponse,
  type HealthResponse,
  type WebhookAck,
} from "./models.ts";
import { FlowError, createPaymentLinkForDeal } from "./paymentLinks.ts";
import type { RazorpayClient } from "./razorpay.ts";
import { dedupeKey, processWebhook, verifySignature, type ProcessedEventStore } from "./webhookHandler.ts";

export interface AppDeps {
  config: Config;
  bitrix: BitrixClient;
  razorpay: RazorpayClient;
  eventStore: ProcessedEventStore;
}

export interface CreatedApp {
  app: express.Express;
  /**
   * Resolves once all background webhook processing has finished. main.ts calls
   * this during shutdown, so a Bitrix comment isn't cut off halfway through.
   */
  drain: () => Promise<void>;
}

export function createApp(deps: AppDeps): CreatedApp {
  const { config, bitrix, razorpay, eventStore } = deps;
  const app = express();

  // Webhook processing still running after its 200 reply has been sent.
  const backgroundWork = new Set<Promise<void>>();

  // Don't advertise "X-Powered-By: Express" to the world.
  app.disable("x-powered-by");

  app.use(logRequests);

  // IMPORTANT: there is NO global app.use(express.json()) here. A global JSON
  // parser would read and parse the webhook body before our route sees it, and
  // the signature must be checked against the raw, untouched bytes. So each
  // route picks its own body parser.
  const parseJsonOrForm = [
    express.json({ limit: "100kb" }),
    // extended: true turns form fields like document_id[2]=DEAL_42 into arrays,
    // which is how Bitrix business processes send the deal (see models.ts).
    express.urlencoded({ extended: true, limit: "100kb" }),
  ];

  // ------------------------------------------------------------------ GET /health
  // For uptime monitors and load balancers: "is the process alive?". Deliberately
  // doesn't call Bitrix or Razorpay, so a Bitrix outage doesn't make monitors
  // restart a perfectly healthy service.
  app.get("/health", (_req, res: Response<HealthResponse>) => {
    res.json({ status: "ok" });
  });

  // ------------------------------------------------------------------ POST /payment-links
  // Bitrix calls this (e.g. from an automation rule) with the deal ID.
  app.post("/payment-links", ...parseJsonOrForm, requireToken(config), async (req, res) => {
    let dealId: string;
    try {
      dealId = extractDealId(req.query, req.body);
    } catch (err) {
      if (err instanceof RequestValidationError) return sendError(res, 400, "BAD_REQUEST", err.message);
      throw err;
    }

    try {
      const result = await createPaymentLinkForDeal(dealId, { config, bitrix, razorpay });
      res.status(201).json(result); // 201 Created: a new resource (the link) exists now
    } catch (err) {
      if (err instanceof FlowError) {
        // Already commented on the deal by the flow. Just answer the caller.
        return sendError(res, err.httpStatus, err.code, err.message, err.dealId);
      }
      throw err; // unexpected: handled by the error middleware below
    }
  });

  // ------------------------------------------------------------------ POST /webhooks/razorpay
  // express.raw() gives us req.body as a Buffer of the exact bytes received.
  // `type: "*/*"` accepts any Content-Type, so a missing or odd header can't make
  // the body silently disappear.
  app.post("/webhooks/razorpay", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // ---- 1. Signature: before ANYTHING else, including JSON parsing.
    const signature = req.get("x-razorpay-signature");
    if (!verifySignature(rawBody, signature, config.razorpayWebhookSecret.reveal())) {
      console.warn(`[webhook] Rejected request with ${signature ? "an invalid" : "no"} signature`);
      return sendError(res, 400, "INVALID_SIGNATURE", "Invalid signature");
    }

    // ---- 2. Parse. From here on the request is genuinely from Razorpay.
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return sendError(res, 400, "BAD_REQUEST", "Body is not valid JSON");
    }
    const parsed = RazorpayWebhookSchema.safeParse(json);
    if (!parsed.success) {
      // Signed by Razorpay but not a shape we understand. Answer 200 anyway:
      // resending the same payload won't change anything.
      console.error("[webhook] Unrecognised payload, ignoring", parsed.error.issues);
      return res.json({ status: "ignored" } satisfies WebhookAck);
    }
    const webhook = parsed.data;

    // Events we don't handle (refunds, subscriptions...): acknowledge them so
    // Razorpay stops sending, but don't fill the duplicate store with them.
    if (!isHandledEvent(webhook.event)) {
      return res.json({ status: "ignored" } satisfies WebhookAck);
    }

    // ---- 3. Duplicate check
    const key = dedupeKey(req.get("x-razorpay-event-id"), webhook);
    if (!eventStore.claim(key)) {
      console.info(`[webhook] Duplicate ${webhook.event} (${key}), already processed`);
      return res.json({ status: "duplicate" } satisfies WebhookAck);
    }

    // ---- 4. Answer 200 NOW, then do the slow work.
    // WHY: Razorpay waits only a few seconds, and treats anything but 2xx (or a
    // timeout) as a failure and retries, for up to 24 hours. Talking to Bitrix
    // can be slow. Replying first means a slow or broken CRM never causes
    // retries; problems are logged instead.
    res.json({ status: "accepted" } satisfies WebhookAck);

    // Not awaited on purpose: this keeps running after the response is sent.
    // processWebhook never throws; the .catch is a belt-and-braces guard,
    // because an unhandled rejection would crash the process.
    // The promise is remembered until it settles, so shutdown can wait for it.
    const work = processWebhook(webhook, { bitrix, razorpay, moveDealToWon: config.moveDealToWon }).then(
      () => undefined,
      (err) => console.error("[webhook] processWebhook threw unexpectedly", err),
    );
    backgroundWork.add(work);
    void work.finally(() => backgroundWork.delete(work));
  });

  // ------------------------------------------------------------------ GET /bitrix/deal-fields
  // Same information as `npm run list-fields`, over HTTP. Protected by the token
  // (if set) because it reveals your CRM's structure.
  app.get("/bitrix/deal-fields", requireToken(config), async (req, res) => {
    const all = req.query.all === "true";
    const fields = await bitrix.listDealFields();
    res.json(
      Object.entries(fields)
        .filter(([name]) => all || name.startsWith("UF_CRM_"))
        .map(([name, def]) => ({
          name,
          type: def.type,
          label: def.listLabel || def.formLabel || def.editFormLabel || def.title || "",
        })),
    );
  });

  // ------------------------------------------------------------------ fallbacks
  app.use((req, res) => sendError(res, 404, "NOT_FOUND", `No route for ${req.method} ${req.path}`));

  // Express recognises an error handler by its 4 parameters, so `_next` must stay
  // even though it's unused. Express 5 also sends errors from async handlers
  // here automatically.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Body parser errors carry a status: malformed JSON (400), body too large (413).
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      return sendError(res, status, "BAD_REQUEST", (err as Error).message);
    }
    console.error("[app] Unhandled error", err);
    const code: ErrorCode = err instanceof Error && err.name.startsWith("Bitrix") ? "BITRIX_ERROR" : "INTERNAL_ERROR";
    return sendError(res, 500, code, "Internal error. Details are in the server logs.");
  });

  // Loop because more work could start while we wait (only if requests are
  // still arriving; during shutdown the server has already stopped accepting them).
  const drain = async () => {
    while (backgroundWork.size > 0) await Promise.allSettled([...backgroundWork]);
  };

  return { app, drain };
}

// --------------------------------------------------------------------------- helpers

function sendError(res: Response, status: number, code: ErrorCode, message: string, dealId?: string) {
  const body: ErrorResponse = { status: "error", error_code: code, message, ...(dealId && { deal_id: dealId }) };
  return res.status(status).json(body);
}

/**
 * Middleware: if INBOUND_API_TOKEN is set, require ?token=... (or an
 * X-Api-Token header) to match it. If it isn't set, let everything through.
 *
 * The comparison uses timingSafeEqual for the same reason as the webhook
 * signature (see webhookHandler.ts).
 */
function requireToken(config: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = config.inboundApiToken?.reveal();
    if (!expected) return next();
    const given = typeof req.query.token === "string" ? req.query.token : (req.get("x-api-token") ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return next();
    return sendError(res, 401, "UNAUTHORIZED", "Missing or invalid token");
  };
}

/**
 * Log one line per request: method, path, status, duration.
 *
 * Logs req.path, NOT req.originalUrl: the full URL can contain ?token=..., and
 * secrets must never end up in log files.
 */
function logRequests(req: Request, res: Response, next: NextFunction) {
  const start = performance.now();
  res.on("finish", () => {
    const ms = Math.round(performance.now() - start);
    console.info(`[http] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
}

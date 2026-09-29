/**
 * Application settings, loaded from environment variables (and a local `.env` file).
 *
 * WHY validate config with zod?
 *   Secrets like API keys must never live in source code, so they come from the
 *   environment. But environment variables are all untyped strings: "false" is a
 *   truthy string, and a typo'd name is just `undefined`. zod checks and converts
 *   everything once, at startup, and fails loudly if something required is missing.
 *   Failing at startup is far better than failing on the first real payment.
 */

import { existsSync, readFileSync } from "node:fs";
import { inspect, parseEnv } from "node:util";
import { z } from "zod";

// --------------------------------------------------------------------------- Secret

/**
 * Wraps a secret string so it can't leak into logs by accident.
 *
 * `console.log(config)` or `JSON.stringify(config)` shows "**********" instead of
 * the key. Call `.reveal()` at the one place you actually need the raw value
 * (e.g. building the Razorpay auth header).
 */
export class Secret {
  readonly #value: string; // `#` = truly private field; not visible even when inspecting the object

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "**********";
  }

  toJSON(): string {
    return "**********";
  }

  // Controls what console.log / util.inspect print.
  [inspect.custom](): string {
    return "Secret(**********)";
  }
}

// --------------------------------------------------------------------------- schema

const requiredString = (name: string) => z.string({ error: `${name} is required` }).trim().min(1, `${name} is required`);
const secret = (name: string) => requiredString(name).transform((value) => new Secret(value));

// Bitrix custom field API names always look like UF_CRM_<something>. Catching a
// pasted *label* (e.g. "Payment link") here is much friendlier than a confusing
// Bitrix error later.
const ufField = (name: string) =>
  requiredString(name).regex(/^UF_CRM_\w+$/, `${name} must be a field API name like UF_CRM_1234567890`);

// z.stringbool() accepts "true"/"false", "1"/"0", "yes"/"no", "on"/"off".
// (Beware z.coerce.boolean(): it uses JS truthiness, so the string "false" becomes true!)
const flag = z.stringbool().default(false);

const envSchema = z.object({
  // ---------------------------------------------------------------- Bitrix24
  // The inbound webhook base URL, e.g. https://portal.bitrix24.in/rest/1/abc123/
  // The secret token is part of the URL itself, so treat the whole URL like a password.
  BITRIX_WEBHOOK_URL: z
    .url({ error: "BITRIX_WEBHOOK_URL must be a full URL like https://portal.bitrix24.in/rest/1/abc123/" })
    // We build method URLs as `${base}${method}.json`. Without the trailing slash
    // we'd get ".../abc123crm.deal.get.json", a confusing 404.
    .transform((url) => (url.endsWith("/") ? url : `${url}/`)),

  // API names of the two custom deal fields we write to.
  // Run `npm run list-fields` to find these for your portal.
  BITRIX_PAYMENT_LINK_FIELD: ufField("BITRIX_PAYMENT_LINK_FIELD"),
  BITRIX_PAYMENT_ID_FIELD: ufField("BITRIX_PAYMENT_ID_FIELD"),

  // ---------------------------------------------------------------- Razorpay
  // Test keys start with rzp_test_, live keys with rzp_live_.
  RAZORPAY_KEY_ID: requiredString("RAZORPAY_KEY_ID").regex(
    /^rzp_(test|live)_\w+$/,
    "RAZORPAY_KEY_ID must start with rzp_test_ or rzp_live_",
  ),
  RAZORPAY_KEY_SECRET: secret("RAZORPAY_KEY_SECRET"),
  // Set when you create the webhook in the Razorpay dashboard. Used to prove that
  // an incoming webhook really came from Razorpay.
  RAZORPAY_WEBHOOK_SECRET: secret("RAZORPAY_WEBHOOK_SECRET"),

  // ---------------------------------------------------------------- Behaviour
  // When a link is fully paid, also move the deal to the "Won" stage.
  MOVE_DEAL_TO_WON: flag,

  // Optional shared secret for POST /payment-links. Without it, anyone who finds
  // your URL could create payment links for your deals. If set, callers must send
  // it as ?token=... (easy to add to a Bitrix24 robot URL).
  INBOUND_API_TOKEN: z.string().trim().min(1).transform((value) => new Secret(value)).optional(),

  // Allow customers to pay in instalments. Razorpay only sends the
  // payment_link.partially_paid event when this is enabled on the link.
  RAZORPAY_ACCEPT_PARTIAL: flag,

  // Link expiry in days. Razorpay only sends payment_link.expired when the link
  // has an expiry time. Leave empty for links that never expire.
  PAYMENT_LINK_EXPIRE_DAYS: z.coerce.number().int().positive().optional(),

  // Where we remember which webhook events we've already processed (idempotency).
  PROCESSED_EVENTS_PATH: z.string().default("data/processed_events.json"),

  // Where we remember payment links that were created but could neither be saved
  // to the deal nor cancelled, so they block new links even after a restart.
  UNRESOLVED_LINKS_PATH: z.string().default("data/unresolved_links.json"),

  // Name of a DynamoDB table. If set, everything the service remembers goes there
  // instead of the two files above: needed on AWS Lambda, which has no permanent
  // disk and may run several copies at once. Leave empty on a normal server.
  DYNAMODB_TABLE: z.string().trim().min(1).optional(),

  // The ID of the "Recurring" pipeline (yearly subscription renewals). Deals in
  // it get the yearly renewal links from POST /recurring/payment-links. Leave
  // empty to switch that address off. Find the ID with: npm run list-pipelines
  RECURRING_CATEGORY_ID: z
    .string()
    .trim()
    .regex(/^\d+$/, "RECURRING_CATEGORY_ID must be a pipeline ID number (see npm run list-pipelines)")
    .optional(),

  // HTTP port for the Express server.
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
});

// --------------------------------------------------------------------------- Config

/** The validated settings, with friendlier camelCase names for use in code. */
export interface Config {
  bitrixWebhookUrl: string;
  bitrixPaymentLinkField: string;
  bitrixPaymentIdField: string;
  razorpayKeyId: string;
  razorpayKeySecret: Secret;
  razorpayWebhookSecret: Secret;
  moveDealToWon: boolean;
  inboundApiToken: Secret | undefined;
  razorpayAcceptPartial: boolean;
  paymentLinkExpireDays: number | undefined;
  processedEventsPath: string;
  unresolvedLinksPath: string;
  dynamodbTable: string | undefined;
  /** The Recurring pipeline's ID; undefined = recurring renewal links switched off. */
  recurringCategoryId: string | undefined;
  port: number;
}

/**
 * Validate an environment object and build the Config.
 *
 * Takes `env` as a parameter (defaulting to process.env) so tests can pass in a
 * plain object instead of mutating the real environment.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // `.env.example` lists optional variables as `NAME=` (empty). Treat an empty
  // string as "not set", so defaults apply and "" isn't parsed as a number.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));

  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    // One line per problem, e.g. "  - RAZORPAY_KEY_ID: RAZORPAY_KEY_ID is required"
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration. Check your .env file:\n${problems.join("\n")}`);
  }

  const e = result.data;
  return {
    bitrixWebhookUrl: e.BITRIX_WEBHOOK_URL,
    bitrixPaymentLinkField: e.BITRIX_PAYMENT_LINK_FIELD,
    bitrixPaymentIdField: e.BITRIX_PAYMENT_ID_FIELD,
    razorpayKeyId: e.RAZORPAY_KEY_ID,
    razorpayKeySecret: e.RAZORPAY_KEY_SECRET,
    razorpayWebhookSecret: e.RAZORPAY_WEBHOOK_SECRET,
    moveDealToWon: e.MOVE_DEAL_TO_WON,
    inboundApiToken: e.INBOUND_API_TOKEN,
    razorpayAcceptPartial: e.RAZORPAY_ACCEPT_PARTIAL,
    paymentLinkExpireDays: e.PAYMENT_LINK_EXPIRE_DAYS,
    processedEventsPath: e.PROCESSED_EVENTS_PATH,
    unresolvedLinksPath: e.UNRESOLVED_LINKS_PATH,
    dynamodbTable: e.DYNAMODB_TABLE,
    recurringCategoryId: e.RECURRING_CATEGORY_ID,
    port: e.PORT,
  };
}

/**
 * Read a `.env` file (if present) into process.env, without overwriting variables
 * that are already set.
 *
 * WHY "don't overwrite": in production you normally set real environment
 * variables and have no .env file. If both exist, the real environment should
 * win, so a stale .env left on a server can't silently override it.
 *
 * Uses Node's built-in parser (util.parseEnv), so no `dotenv` package is needed.
 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

let cached: Config | undefined;

/**
 * Return the app config, loading and validating it on first use.
 *
 * WHY cache: validating on every request is wasteful. This works like a
 * lazily created singleton.
 */
export function getConfig(): Config {
  if (!cached) {
    loadDotEnv();
    cached = loadConfig();
  }
  return cached;
}

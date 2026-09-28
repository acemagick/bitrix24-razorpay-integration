/**
 * The AWS Lambda entry point: the "front door" AWS calls for every request.
 *
 * HOW LAMBDA DIFFERS FROM main.ts
 *   main.ts starts a web server that listens on a port and waits. Lambda has no
 *   waiting server: when a request arrives at the function's URL, AWS starts
 *   (or reuses) a copy of this code and calls `handler` once, passing the
 *   request as a plain data object (an "event"). Whatever `handler` returns is
 *   sent back as the response.
 *
 * THE TRANSLATOR
 *   Our routes are an Express app, which expects real web requests. The
 *   serverless-express package translates: event -> Express request, and
 *   Express response -> the object Lambda wants back. So every route, check and
 *   error message is exactly the same code the normal server runs.
 *
 * THE RAW BODY
 *   Razorpay's signature must be checked against the exact bytes it sent.
 *   Lambda sometimes hands over the body "base64-encoded" (turned into plain
 *   letters for transport). serverless-express decodes it back into the
 *   original bytes before our route sees it; tests/lambda.test.ts checks this.
 *
 * WHAT'S SWITCHED ON HERE (and not in main.ts)
 *   - processWebhooksInline: finish the Bitrix work before answering Razorpay,
 *     because Lambda freezes the code as soon as the answer is sent (change 1).
 *   - DynamoDB storage: Lambda has no permanent disk and may run several copies
 *     at once (change 2). DYNAMODB_TABLE must be set.
 */

import { configure as serverlessExpress } from "@codegenie/serverless-express";
import type { APIGatewayProxyStructuredResultV2, Context, LambdaFunctionURLEvent } from "aws-lambda";

import { createApp, type AppDeps } from "./app.ts";
import { BitrixClient } from "./bitrix.ts";
import { getConfig, type Config } from "./config.ts";
import { createStorage } from "./createStorage.ts";
import { RazorpayClient } from "./razorpay.ts";

/**
 * The answer Lambda sends back: status code, headers and body. (A Function URL
 * also accepts a bare string, but the translator always returns this full form.)
 */
export type LambdaResult = APIGatewayProxyStructuredResultV2;
export type LambdaHandler = (event: LambdaFunctionURLEvent, context: Context) => Promise<LambdaResult>;

/**
 * Wrap the Express app for Lambda, with the Lambda-only behaviour switched on.
 * Takes its dependencies as a parameter so tests can use fake Bitrix, Razorpay
 * and DynamoDB (tests/lambda.test.ts); `handler` below passes the real ones.
 */
export function createLambdaHandler(deps: Omit<AppDeps, "processWebhooksInline">): LambdaHandler {
  const { app } = createApp({ ...deps, processWebhooksInline: true });
  const translate = serverlessExpress({ app });
  // The third argument (a callback) is only for an older calling style; this
  // package answers with a Promise by default, so it's never called.
  return (event, context) => translate(event, context, () => {}) as Promise<LambdaResult>;
}

/**
 * Refuse to start on Lambda without DynamoDB. Without it the service would fall
 * back to files, which Lambda forgets, and duplicate protection would silently stop working.
 */
export function assertLambdaConfig(config: Config): void {
  if (!config.dynamodbTable) {
    throw new Error(
      "DYNAMODB_TABLE is not set. On AWS Lambda the service must keep its records in DynamoDB: " +
        "set DYNAMODB_TABLE to the table's name in the function's environment variables.",
    );
  }
}

/**
 * One-time setup for a fresh copy of the function (a "cold start"): read the
 * settings, create the clients and storage, build the app.
 *
 * WHY ONLY ONCE: AWS reuses a copy for many requests in a row. Setting up once
 * and keeping the result makes every later request faster.
 */
async function setUp(): Promise<LambdaHandler> {
  // Settings come from the function's environment variables (no .env file on Lambda).
  const config = getConfig();
  assertLambdaConfig(config);
  const storage = await createStorage(config);
  const mode = config.razorpayKeyId.startsWith("rzp_test_") ? "TEST" : "LIVE";
  console.info(`[lambda] Ready (Razorpay ${mode} mode). Storage: ${storage.description}`);

  return createLambdaHandler({
    config,
    bitrix: new BitrixClient(config.bitrixWebhookUrl),
    razorpay: new RazorpayClient(config.razorpayKeyId, config.razorpayKeySecret.reveal()),
    eventStore: storage.eventStore,
    unresolvedLinks: storage.unresolvedLinks,
    dealLock: storage.dealLock,
  });
}

let ready: Promise<LambdaHandler> | undefined;

/**
 * What AWS calls. Point the function's "handler" setting at this export.
 *
 * If setup fails, the error is logged in CloudWatch and the request fails; the
 * next request tries the setup again (useful if the failure was temporary).
 * A wrong or missing setting: fix it in the function's configuration. Saving a
 * configuration change makes AWS start fresh copies, which read the new
 * settings, so there's no need to redeploy the code.
 */
export async function handler(event: LambdaFunctionURLEvent, context: Context): Promise<LambdaResult> {
  ready ??= setUp().catch((err: unknown) => {
    ready = undefined;
    console.error("[lambda] Setup failed", err);
    throw err;
  });
  const handle = await ready;
  return handle(event, context);
}

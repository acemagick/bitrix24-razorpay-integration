/**
 * The Lambda front door (src/lambda.ts), fed with events shaped exactly like the
 * ones AWS sends from a Lambda Function URL, with fake Bitrix, Razorpay and
 * DynamoDB behind it. Nothing is sent to AWS.
 */

import type { Context, LambdaFunctionURLEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";

import { createDynamoStorage } from "../src/dynamoStorage.ts";
import { assertLambdaConfig, createLambdaHandler } from "../src/lambda.ts";
import {
  FakeDynamo,
  createFakeBitrix,
  createFakeRazorpay,
  deal,
  linkEntity,
  paymentEntity,
  sign,
  testConfig,
  webhookBody,
} from "./helpers.ts";

/** A request as a Lambda Function URL delivers it (payload format 2.0). */
function functionUrlEvent(options: {
  method?: string;
  path: string;
  query?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Deliver the body the way Lambda sometimes does: base64-encoded. */
  base64?: boolean;
}): LambdaFunctionURLEvent {
  const method = options.method ?? "GET";
  const query = options.query ?? "";
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: options.path,
    rawQueryString: query,
    headers: { host: "abc123.lambda-url.ap-south-1.on.aws", ...options.headers },
    ...(query && { queryStringParameters: Object.fromEntries(new URLSearchParams(query)) }),
    requestContext: {
      accountId: "anonymous",
      apiId: "abc123",
      domainName: "abc123.lambda-url.ap-south-1.on.aws",
      domainPrefix: "abc123",
      http: { method, path: options.path, protocol: "HTTP/1.1", sourceIp: "203.0.113.7", userAgent: "test" },
      requestId: "req-1",
      routeKey: "$default",
      stage: "$default",
      time: "28/Sep/2026:10:00:00 +0000",
      timeEpoch: 1_790_000_000_000,
    },
    isBase64Encoded: options.base64 ?? false,
    ...(options.body !== undefined && {
      body: options.base64 ? Buffer.from(options.body, "utf8").toString("base64") : options.body,
    }),
  };
}

const context = { functionName: "b24-razorpay", awsRequestId: "req-1" } as Context;

/**
 * A "copy" of the Lambda function. Pass the same `dynamo` to two copies to
 * simulate two instances AWS runs side by side.
 */
function lambdaCopy(env: Record<string, string> = {}, dynamo = new FakeDynamo()) {
  const bitrix = createFakeBitrix();
  const rzp = createFakeRazorpay();
  bitrix.deals.set("54", deal());
  bitrix.deals.set("42", deal({ ID: "42", UF_CRM_LINK_ID: "plink_ABC" })); // matches linkEntity()
  const storage = createDynamoStorage("test-table", dynamo);
  const handle = createLambdaHandler({
    config: testConfig({ DYNAMODB_TABLE: "test-table", ...env }),
    bitrix: bitrix.client,
    razorpay: rzp.client,
    ...storage,
  });
  return { handle, bitrix, rzp, dynamo };
}

const paidBody = webhookBody("payment_link.paid", {
  payment_link: linkEntity({ amount_paid: 149_999, description: "Website redesign ₹" }),
  payment: paymentEntity(),
});

const webhookEvent = (body: string, extra: Partial<Parameters<typeof functionUrlEvent>[0]> = {}) =>
  functionUrlEvent({
    method: "POST",
    path: "/webhooks/razorpay",
    headers: { "content-type": "application/json", "x-razorpay-signature": sign(body), "x-razorpay-event-id": "evt_1" },
    body,
    ...extra,
  });

// --------------------------------------------------------------------------- basics

describe("the Lambda front door", () => {
  it("answers GET /health", async () => {
    const { handle } = lambdaCopy();
    const result = await handle(functionUrlEvent({ path: "/health" }), context);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(String(result.body))).toEqual({ status: "ok" });
  });

  it("creates a payment link, reading deal_id and the token from the query string", async () => {
    const { handle, bitrix, dynamo } = lambdaCopy({ INBOUND_API_TOKEN: "s3cret" });

    const result = await handle(
      functionUrlEvent({ method: "POST", path: "/payment-links", query: "deal_id=54&token=s3cret" }),
      context,
    );

    expect(result.statusCode).toBe(201);
    expect(JSON.parse(String(result.body))).toMatchObject({ status: "created", deal_id: "54" });
    expect(bitrix.comments("54")[0]).toMatch(/^Razorpay: Payment link created/);
    expect(dynamo.items.has("lock#54")).toBe(false); // the DynamoDB deal lock was released
  });

  it("rejects a wrong token", async () => {
    const { handle } = lambdaCopy({ INBOUND_API_TOKEN: "s3cret" });
    const result = await handle(functionUrlEvent({ method: "POST", path: "/payment-links", query: "deal_id=54&token=guess" }), context);
    expect(result.statusCode).toBe(401);
  });
});

// --------------------------------------------------------------------------- webhooks

describe("Razorpay webhooks through the Lambda front door", () => {
  it.each([
    ["as plain text", false],
    ["base64-encoded, as Lambda sometimes delivers it", true],
  ])("the signature still matches when the body arrives %s", async (_label, base64) => {
    const { handle } = lambdaCopy();
    const result = await handle(webhookEvent(paidBody, { base64 }), context);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(String(result.body))).toEqual({ status: "accepted" });
  });

  it("keeps odd spacing and non-English characters byte-for-byte (the ₹ above, and this)", async () => {
    const { handle } = lambdaCopy();
    const unusual = paidBody.replace(/,/g, " ,  ").replace("Website redesign", "वेबसाइट");
    const result = await handle(webhookEvent(unusual), context);
    expect(JSON.parse(String(result.body))).toEqual({ status: "accepted" });
  });

  it("rejects a wrong signature with 400", async () => {
    const { handle, bitrix } = lambdaCopy();
    const event = webhookEvent(paidBody);
    event.headers["x-razorpay-signature"] = sign(paidBody, "someone-elses-secret");
    const result = await handle(event, context);
    expect(result.statusCode).toBe(400);
    expect(bitrix.calls).toEqual([]);
  });

  it("posts the comment BEFORE answering (nothing is left for Lambda to freeze)", async () => {
    const { handle, bitrix } = lambdaCopy();
    await handle(webhookEvent(paidBody), context);
    // No drain() or waiting: by the time the answer came back, the comment was posted.
    expect(bitrix.comments("42")).toEqual([expect.stringMatching(/^Razorpay: Payment successful/)]);
  });

  it("a resend reaching ANOTHER copy of the function is recognised as a duplicate", async () => {
    const sharedTable = new FakeDynamo();
    const copyA = lambdaCopy({}, sharedTable);
    const copyB = lambdaCopy({}, sharedTable);

    const first = await copyA.handle(webhookEvent(paidBody), context);
    const resend = await copyB.handle(webhookEvent(paidBody), context);

    expect(JSON.parse(String(first.body))).toEqual({ status: "accepted" });
    expect(JSON.parse(String(resend.body))).toEqual({ status: "duplicate" });
    expect(copyB.bitrix.comments()).toEqual([]); // copy B didn't comment again
  });
});

// --------------------------------------------------------------------------- setup check

describe("assertLambdaConfig", () => {
  it("refuses to run on Lambda without DYNAMODB_TABLE (files would be forgotten)", () => {
    expect(() => assertLambdaConfig(testConfig())).toThrow(/DYNAMODB_TABLE is not set/);
    expect(() => assertLambdaConfig(testConfig({ DYNAMODB_TABLE: "b24-razorpay" }))).not.toThrow();
  });
});

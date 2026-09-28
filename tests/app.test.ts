/**
 * The HTTP layer: the real Express app on a random port, spoken to over real
 * HTTP, with fake Bitrix and Razorpay behind it.
 */

import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createApp, type AppDeps } from "../src/app.ts";
import { StorageError } from "../src/storage.ts";
import { UnresolvedLinkStore } from "../src/paymentLinks.ts";
import { ProcessedEventStore } from "../src/webhookHandler.ts";
import {
  createFakeBitrix,
  createFakeRazorpay,
  deal,
  json,
  linkEntity,
  makeTempDir,
  paymentEntity,
  sign,
  testConfig,
  webhookBody,
} from "./helpers.ts";

async function startApp(
  env: Record<string, string> = {},
  options: Partial<Pick<AppDeps, "processWebhooksInline" | "eventStore" | "dealLock">> = {},
) {
  const bitrix = createFakeBitrix();
  const rzp = createFakeRazorpay();
  bitrix.deals.set("54", deal());
  // The webhook fixtures are for deal 42's saved link, plink_ABC.
  bitrix.deals.set("42", deal({ ID: "42", UF_CRM_LINK_ID: "plink_ABC" }));

  const dir = await mkdtemp(join(tmpdir(), "b24rzp-app-"));
  const eventStore = new ProcessedEventStore(join(dir, "events.json"));
  const unresolvedLinks = new UnresolvedLinkStore(join(dir, "unresolved.json"));
  const { app, drain } = createApp({
    config: testConfig(env),
    bitrix: bitrix.client,
    razorpay: rzp.client,
    eventStore,
    unresolvedLinks,
    ...options,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  // One cleanup, in the right order: stop the server, let background work and
  // pending file writes finish, THEN delete the folder they write into.
  onTestFinished(async () => {
    await new Promise((resolve) => server.close(resolve));
    await drain();
    await eventStore.flush();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, bitrix, rzp, drain, eventStore };
}

/** POST a webhook body to the app, signed with the test secret unless told otherwise. */
function postWebhook(base: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${base}/webhooks/razorpay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Razorpay-Signature": sign(body), ...headers },
    body,
  });
}

// --------------------------------------------------------------------------- basics

describe("GET /health", () => {
  it('answers {"status":"ok"} without touching Bitrix or Razorpay', async () => {
    const { base, bitrix, rzp } = await startApp();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(bitrix.calls).toEqual([]);
    expect(rzp.calls).toEqual([]);
  });
});

it("answers unknown routes with a JSON 404", async () => {
  const { base } = await startApp();
  const response = await fetch(`${base}/nope`);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ status: "error", error_code: "NOT_FOUND" });
});

// --------------------------------------------------------------------------- flow 1

describe("POST /payment-links", () => {
  it.each([
    ["query string", "?deal_id=54", undefined, undefined],
    ["JSON body", "", "application/json", JSON.stringify({ deal_id: 54 })],
    [
      "Bitrix business-process form",
      "",
      "application/x-www-form-urlencoded",
      "document_id%5B0%5D=crm&document_id%5B1%5D=CCrmDocumentDeal&document_id%5B2%5D=DEAL_54",
    ],
  ])("creates a link with the deal ID in the %s", async (_label, query, contentType, body) => {
    const { base } = await startApp();
    const response = await fetch(`${base}/payment-links${query}`, {
      method: "POST",
      ...(contentType && { headers: { "Content-Type": contentType } }),
      body,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "created", deal_id: "54", short_url: "https://rzp.io/rzp/fake1" });
  });

  it("returns 400 without a deal ID", async () => {
    const { base } = await startApp();
    const response = await fetch(`${base}/payment-links`, { method: "POST" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "BAD_REQUEST" });
  });

  it("returns 400 for malformed JSON", async () => {
    const { base } = await startApp();
    const response = await fetch(`${base}/payment-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    });
    expect(response.status).toBe(400);
  });

  it("passes the flow's error code and status through", async () => {
    const { base } = await startApp();
    const response = await fetch(`${base}/payment-links?deal_id=999`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ status: "error", error_code: "DEAL_NOT_FOUND", deal_id: "999" });
  });

  describe("with INBOUND_API_TOKEN set", () => {
    it.each([
      ["no token", "", {}, 401],
      ["a wrong token", "&token=guess", {}, 401],
      ["?token=", "&token=s3cret", {}, 201],
      ["an X-Api-Token header", "", { "X-Api-Token": "s3cret" }, 201],
    ])("answers %s with %i", async (_label, tokenQuery, headers, status) => {
      const { base } = await startApp({ INBOUND_API_TOKEN: "s3cret" });
      const response = await fetch(`${base}/payment-links?deal_id=54${tokenQuery}`, { method: "POST", headers });
      expect(response.status).toBe(status);
    });

    it("never writes the token into the logs", async () => {
      const { base } = await startApp({ INBOUND_API_TOKEN: "s3cret" });
      await fetch(`${base}/payment-links?deal_id=54&token=s3cret`, { method: "POST" });
      const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
      expect(logged).toContain("POST /payment-links");
      expect(logged).not.toContain("s3cret");
    });
  });
});

// --------------------------------------------------------------------------- flow 2

describe("POST /webhooks/razorpay", () => {
  const paidBody = webhookBody("payment_link.paid", {
    payment_link: linkEntity({ amount_paid: 149_999 }),
    payment: paymentEntity(),
  });

  it("accepts a signed webhook, answers at once, then comments on the deal", async () => {
    const { base, bitrix, drain } = await startApp();

    const response = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted" });
    await drain(); // wait for the background work
    expect(bitrix.comments("42")).toEqual([expect.stringMatching(/^Razorpay: Payment successful/)]);
  });

  it.each([
    ["a wrong signature", { "X-Razorpay-Signature": sign(paidBody, "someone-elses-secret") }],
    ["no signature", { "X-Razorpay-Signature": "" }],
  ])("rejects %s with 400 and does nothing", async (_label, headers) => {
    const { base, bitrix, drain } = await startApp();
    const response = await postWebhook(base, paidBody, headers);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: "INVALID_SIGNATURE" });
    await drain();
    expect(bitrix.calls).toEqual([]);
  });

  it("checks the signature against the exact bytes received (odd spacing included)", async () => {
    const { base } = await startApp();
    const oddlySpaced = paidBody.replace(/,/g, " ,  ");
    const response = await postWebhook(base, oddlySpaced);
    expect(await response.json()).toEqual({ status: "accepted" });
  });

  it("processes a resent event only once", async () => {
    const { base, bitrix, drain } = await startApp();

    const first = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });
    await drain(); // the first has finished its Bitrix work, so it now counts as processed
    const second = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });

    expect(await first.json()).toEqual({ status: "accepted" });
    expect(await second.json()).toEqual({ status: "duplicate" });
    await drain();
    expect(bitrix.comments("42")).toHaveLength(1);
  });

  it("ignores events it doesn't handle, without remembering them", async () => {
    const { base, eventStore } = await startApp();
    const response = await postWebhook(base, webhookBody("refund.created"), { "X-Razorpay-Event-Id": "evt_refund" });
    expect(await response.json()).toEqual({ status: "ignored" });
    expect(eventStore.has("evt_refund")).toBe(false);
  });

  it("answers 200 to a signed payload it can't parse, since resending won't help", async () => {
    const { base } = await startApp();
    const response = await postWebhook(base, JSON.stringify({ unexpected: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ignored" });
  });

  it("rejects a signed body that isn't JSON", async () => {
    const { base } = await startApp();
    expect((await postWebhook(base, "not json")).status).toBe(400);
  });

  it("answers before Bitrix has finished, and drain() waits for Bitrix", async () => {
    const { base, bitrix, drain } = await startApp();
    let commentFinished = false;
    // A slow portal: the comment call hangs until the test releases it.
    let releaseComment!: () => void;
    const commentGate = new Promise<void>((resolve) => (releaseComment = resolve));
    bitrix.failOn("crm.timeline.comment.add", async () => {
      await commentGate;
      commentFinished = true;
      return json(200, { result: 1 });
    });

    await postWebhook(base, paidBody);
    expect(commentFinished).toBe(false); // Razorpay already has its 200

    releaseComment();
    await drain();
    expect(commentFinished).toBe(true);
  });

  it("drain() also waits for the event to be saved as processed", async () => {
    const path = join(await makeTempDir(), "events.json");
    const eventStore = new ProcessedEventStore(path);
    const { base, drain } = await startApp({}, { eventStore });

    await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });
    await drain();

    expect(JSON.parse(await readFile(path, "utf8")).map(([id]: [string]) => id)).toEqual(["evt_1"]);
  });

  describe("with processWebhooksInline (AWS Lambda)", () => {
    /** Make Bitrix's comment call hang until the test releases it. */
    function slowComments(bitrix: ReturnType<typeof createFakeBitrix>) {
      const state = { finished: 0, release: () => {} };
      const gate = new Promise<void>((resolve) => (state.release = resolve));
      bitrix.failOn("crm.timeline.comment.add", async () => {
        await gate;
        state.finished++;
        return json(200, { result: 1 });
      });
      return state;
    }

    it("finishes the Bitrix work BEFORE answering Razorpay", async () => {
      const { base, bitrix } = await startApp({}, { processWebhooksInline: true });
      const comments = slowComments(bitrix);

      const pending = postWebhook(base, paidBody);
      await new Promise((resolve) => setTimeout(resolve, 50));
      comments.release();
      const response = await pending;

      // By the time Razorpay has its answer, the comment is already posted:
      // nothing is left running in the background for Lambda to freeze.
      expect(await response.json()).toEqual({ status: "accepted" });
      expect(comments.finished).toBe(1);
    });

    it("asks a resend that arrives while the first is still working to retry, then answers 'duplicate'", async () => {
      const { base, bitrix } = await startApp({}, { processWebhooksInline: true });
      const comments = slowComments(bitrix);

      const first = postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });
      await new Promise((resolve) => setTimeout(resolve, 50)); // first is now waiting on Bitrix
      // Not "duplicate" yet: the first might never finish (e.g. Lambda times out),
      // so a non-2xx makes Razorpay send it again later.
      const second = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error_code: "ALREADY_IN_PROGRESS" });

      comments.release();
      expect(await (await first).json()).toEqual({ status: "accepted" });
      const third = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });
      expect(await third.json()).toEqual({ status: "duplicate" });
      expect(bitrix.comments("42")).toHaveLength(1);
    });

    it("has the event saved as processed before answering 200", async () => {
      // Lambda may freeze right after answering, so the save can't be left for later.
      const path = join(await makeTempDir(), "events.json");
      const eventStore = new ProcessedEventStore(path);
      const { base } = await startApp({}, { processWebhooksInline: true, eventStore });

      const response = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });

      expect(await response.json()).toEqual({ status: "accepted" });
      expect(JSON.parse(await readFile(path, "utf8")).map(([id]: [string]) => id)).toEqual(["evt_1"]);
    });

    it("answers 500 until the record can be saved, then 'duplicate', without redoing the work", async () => {
      // A folder that can't be created (a file is in the way), so every save fails.
      const blocker = join(await makeTempDir(), "not-a-folder");
      await writeFile(blocker, "");
      const path = join(blocker, "events.json");
      const eventStore = new ProcessedEventStore(path);
      const { base, bitrix } = await startApp({}, { processWebhooksInline: true, eventStore });

      const first = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });
      expect(first.status).toBe(500);
      expect(await first.json()).toMatchObject({ error_code: "INTERNAL_ERROR" });

      // Razorpay retries the non-2xx. Still can't save: not acknowledged as a duplicate.
      const stillFailing = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });
      expect(stillFailing.status).toBe(500);

      // Disk fixed: the resend saves the record and only then says "duplicate".
      await rm(blocker);
      const resend = await postWebhook(base, paidBody, { "X-Razorpay-Event-Id": "evt_1" });
      expect(await resend.json()).toEqual({ status: "duplicate" });
      expect(JSON.parse(await readFile(path, "utf8")).map(([id]: [string]) => id)).toEqual(["evt_1"]);
      expect(bitrix.comments("42")).toHaveLength(1);
    });

    it("still answers 200 when Bitrix is down, so Razorpay doesn't keep retrying", async () => {
      const { base, bitrix } = await startApp({}, { processWebhooksInline: true });
      bitrix.failOn("crm.timeline.comment.add", () => new Response("<html>down</html>", { status: 503 }));
      const response = await postWebhook(base, paidBody);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "accepted" });
    });
  });
});

// --------------------------------------------------------------------------- field list

describe("GET /bitrix/deal-fields", () => {
  it("lists the custom fields with their labels", async () => {
    const { base } = await startApp();
    const response = await fetch(`${base}/bitrix/deal-fields`);
    expect(await response.json()).toEqual([
      { name: "UF_CRM_LINK", type: "string", label: "Razorpay Payment Link" },
      { name: "UF_CRM_LINK_ID", type: "string", label: "Razorpay Link ID" },
    ]);
  });

  it("requires the token when one is set", async () => {
    const { base } = await startApp({ INBOUND_API_TOKEN: "s3cret" });
    expect((await fetch(`${base}/bitrix/deal-fields`)).status).toBe(401);
    expect((await fetch(`${base}/bitrix/deal-fields?token=s3cret`)).status).toBe(200);
  });
});

// --------------------------------------------------------------------------- database down

describe("when the service's database (DynamoDB on Lambda) can't be reached", () => {
  const down = () => {
    throw new StorageError("DynamoDB table test: could not reach it: connect ETIMEDOUT");
  };

  it("answers a webhook with 503, so Razorpay sends it again later instead of it being lost", async () => {
    const { base, bitrix, drain } = await startApp(
      {},
      { eventStore: { claim: down, has: down, complete: async () => {}, ensureSaved: async () => {}, release: () => {} } },
    );
    const body = webhookBody("payment_link.paid", { payment_link: linkEntity({ amount_paid: 149_999 }), payment: paymentEntity() });

    const response = await postWebhook(base, body);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "STORAGE_UNAVAILABLE" });
    await drain();
    expect(bitrix.comments("42")).toEqual([]); // nothing done, so the retry can do it properly
  });

  it("refuses to create a link (it can't rule out a double click) and says so on the deal", async () => {
    const { base, bitrix, rzp } = await startApp({}, { dealLock: { acquire: down, release: () => {} } });

    const response = await fetch(`${base}/payment-links?deal_id=54`, { method: "POST" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "STORAGE_UNAVAILABLE" });
    expect(rzp.calls).toEqual([]);
    expect(bitrix.comments("54")[0]).toContain("could not reach its database, so no new link was created");
  });
});

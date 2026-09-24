import { describe, expect, it } from "vitest";

import {
  BitrixApiError,
  BitrixClient,
  BitrixUnavailableError,
  DealNotFoundError,
  parseAmount,
} from "../src/bitrix.ts";
import { createFakeBitrix, deal, json } from "./helpers.ts";

/** A client whose fetch answers with the given responses, one per call. */
function clientAnswering(...answers: (() => Response)[]) {
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls++;
    return answer();
  };
  return { client: new BitrixClient("https://portal.bitrix24.test/rest/1/secret", { fetchFn, retryDelayMs: 0 }), calls: () => calls };
}

describe("BitrixClient.call", () => {
  it("POSTs JSON to <webhook>/<method>.json and returns `result`", async () => {
    const requests: { url: string; body: string }[] = [];
    const client = new BitrixClient("https://portal.bitrix24.test/rest/1/secret", {
      fetchFn: async (url, init) => {
        requests.push({ url: String(url), body: String(init?.body) });
        return json(200, { result: { ID: "7" }, time: {} });
      },
    });
    expect(await client.call("crm.deal.get", { id: 7 })).toEqual({ ID: "7" });
    expect(requests).toEqual([{ url: "https://portal.bitrix24.test/rest/1/secret/crm.deal.get.json", body: '{"id":7}' }]);
  });

  it("treats HTTP 200 with an `error` key as a failure", async () => {
    const { client } = clientAnswering(() => json(200, { error: "ACCESS_DENIED", error_description: "Access denied" }));
    await expect(client.call("crm.deal.get")).rejects.toMatchObject({
      name: "BitrixApiError",
      code: "ACCESS_DENIED",
      description: "Access denied",
    });
  });

  it("reports a non-JSON answer (maintenance page) as unavailable", async () => {
    const { client } = clientAnswering(() => new Response("<html>\r\n  Maintenance\r\n</html>", { status: 503 }));
    const error = await client.call("crm.deal.get").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BitrixUnavailableError);
    expect((error as Error).message).toContain('"<html> Maintenance </html>"'); // whitespace collapsed for readable logs
  });

  it("retries once when rate limited, then succeeds", async () => {
    const { client, calls } = clientAnswering(
      () => json(503, { error: "QUERY_LIMIT_EXCEEDED", error_description: "Too many requests" }),
      () => json(200, { result: true }),
    );
    expect(await client.call("crm.deal.update")).toBe(true);
    expect(calls()).toBe(2);
  });

  it("gives up after one retry when still rate limited", async () => {
    const { client, calls } = clientAnswering(() => json(503, { error: "QUERY_LIMIT_EXCEEDED", error_description: "" }));
    await expect(client.call("crm.deal.update")).rejects.toBeInstanceOf(BitrixApiError);
    expect(calls()).toBe(2);
  });

  it("retries once when the connection is refused (the request never reached Bitrix)", async () => {
    let calls = 0;
    const client = new BitrixClient("https://portal.bitrix24.test/rest/1/secret/", {
      retryDelayMs: 0,
      fetchFn: async () => {
        calls++;
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
    });
    await expect(client.call("crm.timeline.comment.add")).rejects.toThrow(/ECONNREFUSED/);
    expect(calls).toBe(2);
  });

  it("does NOT retry a timeout, because a write may already have happened", async () => {
    let calls = 0;
    const client = new BitrixClient("https://portal.bitrix24.test/rest/1/secret/", {
      retryDelayMs: 0,
      fetchFn: async () => {
        calls++;
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    await expect(client.call("crm.timeline.comment.add")).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });
});

describe("BitrixClient deals", () => {
  it("turns Bitrix's 'Not found' (with an empty error code) into DealNotFoundError", async () => {
    const bitrix = createFakeBitrix();
    await expect(bitrix.client.getDeal(999)).rejects.toBeInstanceOf(DealNotFoundError);
  });

  it("builds a clean DealInfo with the contact's first email and phone", async () => {
    const bitrix = createFakeBitrix();
    bitrix.deals.set("54", deal({ CONTACT_ID: "9", CATEGORY_ID: "3" }));
    bitrix.contacts.set("9", {
      NAME: "Asha",
      LAST_NAME: "Rao",
      EMAIL: [{ VALUE: "" }, { VALUE: "asha@example.com", VALUE_TYPE: "WORK" }],
      PHONE: [{ VALUE: " +91 98765 43210 " }],
    });

    const info = await bitrix.client.getDealWithContact("54");
    expect(info).toMatchObject({
      id: "54",
      title: "Website redesign",
      currency: "INR",
      categoryId: "3",
      contact: { name: "Asha Rao", email: "asha@example.com", phone: "+91 98765 43210" },
    });
    expect(info.amount?.toString()).toBe("11.8");
  });

  it("still returns the deal when its contact can't be loaded", async () => {
    const bitrix = createFakeBitrix();
    bitrix.deals.set("54", deal({ CONTACT_ID: "404" })); // contact 404 doesn't exist
    const info = await bitrix.client.getDealWithContact("54");
    expect(info.contact).toBeUndefined();
  });

  it.each([
    ["0", "WON"],
    ["3", "C3:WON"],
  ])("moves a deal in pipeline %s to stage %s", async (categoryId, stageId) => {
    const bitrix = createFakeBitrix();
    await bitrix.client.moveDealToWon("54", categoryId);
    expect(bitrix.callsTo("crm.deal.update")[0]?.params).toEqual({ id: "54", fields: { STAGE_ID: stageId } });
  });

  it("safeComment reports failure instead of throwing", async () => {
    const bitrix = createFakeBitrix();
    bitrix.failOn("crm.timeline.comment.add", () => new Response("<html>down</html>", { status: 502 }));
    await expect(bitrix.client.safeComment("54", "hello")).resolves.toBe(false);
  });
});

describe("parseAmount", () => {
  it.each([
    ["11.80000000", "11.8"],
    ["17700", "17700"],
    ["0.00000000", "0"],
  ])("parses %s exactly", (raw, expected) => {
    expect(parseAmount(raw)?.toString()).toBe(expected);
  });

  it.each([[""], [null], [undefined], ["abc"]])("returns undefined for %j", (raw) => {
    expect(parseAmount(raw)).toBeUndefined();
  });
});

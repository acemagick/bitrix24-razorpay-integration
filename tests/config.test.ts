import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { testConfig } from "./helpers.ts";

const required = {
  BITRIX_WEBHOOK_URL: "https://portal.bitrix24.test/rest/1/secret/",
  BITRIX_PAYMENT_LINK_FIELD: "UF_CRM_LINK",
  BITRIX_PAYMENT_ID_FIELD: "UF_CRM_LINK_ID",
  RAZORPAY_KEY_ID: "rzp_test_abc123",
  RAZORPAY_KEY_SECRET: "key-secret",
  RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
};

describe("loadConfig", () => {
  it("applies defaults for optional settings", () => {
    const config = loadConfig(required);
    expect(config.moveDealToWon).toBe(false);
    expect(config.razorpayAcceptPartial).toBe(false);
    expect(config.inboundApiToken).toBeUndefined();
    expect(config.paymentLinkExpireDays).toBeUndefined();
    expect(config.port).toBe(8000);
  });

  it("adds the trailing slash to the Bitrix webhook URL", () => {
    const config = loadConfig({ ...required, BITRIX_WEBHOOK_URL: "https://portal.bitrix24.test/rest/1/secret" });
    expect(config.bitrixWebhookUrl).toBe("https://portal.bitrix24.test/rest/1/secret/");
  });

  it('parses "false" as false (the classic z.coerce.boolean() trap)', () => {
    expect(loadConfig({ ...required, MOVE_DEAL_TO_WON: "false" }).moveDealToWon).toBe(false);
    expect(loadConfig({ ...required, MOVE_DEAL_TO_WON: "true" }).moveDealToWon).toBe(true);
    expect(loadConfig({ ...required, MOVE_DEAL_TO_WON: "yes" }).moveDealToWon).toBe(true);
  });

  it("treats empty values (NAME= in .env) as not set", () => {
    const config = loadConfig({ ...required, PAYMENT_LINK_EXPIRE_DAYS: "", INBOUND_API_TOKEN: "", PORT: "" });
    expect(config.paymentLinkExpireDays).toBeUndefined();
    expect(config.inboundApiToken).toBeUndefined();
    expect(config.port).toBe(8000);
  });

  it("lists every problem at once", () => {
    expect(() =>
      loadConfig({ BITRIX_WEBHOOK_URL: "not a url", BITRIX_PAYMENT_LINK_FIELD: "Payment link", RAZORPAY_KEY_ID: "abc" }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /BITRIX_WEBHOOK_URL[\s\S]*BITRIX_PAYMENT_LINK_FIELD: .*UF_CRM[\s\S]*BITRIX_PAYMENT_ID_FIELD is required[\s\S]*rzp_test_ or rzp_live_[\s\S]*RAZORPAY_KEY_SECRET is required/,
        ),
      }),
    );
  });

  it("rejects a field label pasted instead of a UF_CRM_ API name", () => {
    expect(() => loadConfig({ ...required, BITRIX_PAYMENT_ID_FIELD: "Razorpay Link ID" })).toThrow(/UF_CRM_/);
  });

  it("reads the Recurring pipeline's ID, and leaves recurring links off when it's empty", () => {
    expect(loadConfig({ ...required, RECURRING_CATEGORY_ID: "3" }).recurringCategoryId).toBe("3");
    expect(loadConfig({ ...required, RECURRING_CATEGORY_ID: "" }).recurringCategoryId).toBeUndefined();
    expect(loadConfig(required).recurringCategoryId).toBeUndefined();
  });

  it("rejects a pipeline name typed instead of its ID", () => {
    expect(() => loadConfig({ ...required, RECURRING_CATEGORY_ID: "Recurring" })).toThrow(/npm run list-pipelines/);
  });
});

describe("Secret", () => {
  it("never shows the secret in logs or JSON", () => {
    const config = testConfig({ INBOUND_API_TOKEN: "inbound-token" });
    for (const output of [JSON.stringify(config), inspect(config), String(config.razorpayKeySecret)]) {
      expect(output).not.toContain("key-secret");
      expect(output).not.toContain("webhook-secret");
      expect(output).not.toContain("inbound-token");
    }
    expect(config.razorpayKeySecret.reveal()).toBe("key-secret");
  });
});

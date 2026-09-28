import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createStorage } from "../src/createStorage.ts";
import { DynamoDealLock, DynamoEventStore, DynamoUnresolvedLinks } from "../src/dynamoStorage.ts";
import { UnresolvedLinkStore } from "../src/paymentLinks.ts";
import { MemoryDealLock } from "../src/storage.ts";
import { ProcessedEventStore } from "../src/webhookHandler.ts";
import { makeTempDir, testConfig } from "./helpers.ts";

describe("createStorage", () => {
  it("uses files and an in-memory lock when DYNAMODB_TABLE isn't set (a normal server)", async () => {
    const dir = await makeTempDir();
    const storage = await createStorage(
      testConfig({ PROCESSED_EVENTS_PATH: join(dir, "events.json"), UNRESOLVED_LINKS_PATH: join(dir, "unresolved.json") }),
    );
    expect(storage.eventStore).toBeInstanceOf(ProcessedEventStore);
    expect(storage.unresolvedLinks).toBeInstanceOf(UnresolvedLinkStore);
    expect(storage.dealLock).toBeInstanceOf(MemoryDealLock);
    expect(storage.description).toContain("events.json");
  });

  it("uses DynamoDB for everything when DYNAMODB_TABLE is set (AWS Lambda)", async () => {
    // Only builds the objects; nothing is sent to AWS until they're used.
    const storage = await createStorage(testConfig({ DYNAMODB_TABLE: "b24-razorpay" }));
    expect(storage.eventStore).toBeInstanceOf(DynamoEventStore);
    expect(storage.unresolvedLinks).toBeInstanceOf(DynamoUnresolvedLinks);
    expect(storage.dealLock).toBeInstanceOf(DynamoDealLock);
    expect(storage.description).toBe("DynamoDB table b24-razorpay");
  });
});

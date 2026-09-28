/**
 * The DynamoDB versions of the storage contracts (src/dynamoStorage.ts), against
 * a fake DynamoDB that follows the rules the real one enforces.
 */

import { describe, expect, it } from "vitest";

import { createDynamoStorage } from "../src/dynamoStorage.ts";
import { StorageError } from "../src/storage.ts";
import { FakeDynamo } from "./helpers.ts";

/** One fake table plus a clock the test can move, shared by all three stores. */
function setup() {
  const dynamo = new FakeDynamo();
  const clock = { now: 1_800_000_000 };
  const storage = createDynamoStorage("test-table", dynamo, { now: () => clock.now });
  return { dynamo, clock, ...storage };
}

// --------------------------------------------------------------------------- events

describe("DynamoEventStore", () => {
  it("lets only the first claim through, and remembers a handled event", async () => {
    const { eventStore } = setup();
    expect(await eventStore.claim("evt_1")).toBe(true);
    expect(await eventStore.claim("evt_1")).toBe(false); // still being handled
    expect(await eventStore.has("evt_1")).toBe(false);

    await eventStore.complete("evt_1");
    expect(await eventStore.has("evt_1")).toBe(true);
    expect(await eventStore.claim("evt_1")).toBe(false); // done: a resend is a duplicate
  });

  it("two copies of the service claiming the same event at once: exactly one wins", async () => {
    const { dynamo, clock } = setup();
    const copyA = createDynamoStorage("test-table", dynamo, { now: () => clock.now }).eventStore;
    const copyB = createDynamoStorage("test-table", dynamo, { now: () => clock.now }).eventStore;
    const results = await Promise.all([copyA.claim("evt_1"), copyB.claim("evt_1")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("release() lets a resend be handled again", async () => {
    const { eventStore } = setup();
    await eventStore.claim("evt_1");
    await eventStore.release("evt_1");
    expect(await eventStore.claim("evt_1")).toBe(true);
  });

  it("release() never deletes a finished event", async () => {
    const { eventStore } = setup();
    await eventStore.claim("evt_1");
    await eventStore.complete("evt_1");
    await eventStore.release("evt_1");
    expect(await eventStore.has("evt_1")).toBe(true);
  });

  it("takes over a claim abandoned by a copy that was stopped mid-way (after 5 minutes)", async () => {
    const { eventStore, clock } = setup();
    await eventStore.claim("evt_1"); // ...and then that Lambda copy is stopped
    clock.now += 4 * 60;
    expect(await eventStore.claim("evt_1")).toBe(false); // it might still be working
    clock.now += 2 * 60;
    expect(await eventStore.claim("evt_1")).toBe(true);
  });

  it("gives every event row an expiry, so the table cleans itself up", async () => {
    const { eventStore, dynamo, clock } = setup();
    await eventStore.claim("evt_1");
    await eventStore.complete("evt_1");
    expect(dynamo.items.get("event#evt_1")).toEqual({
      pk: "event#evt_1",
      state: "done",
      expiresAt: clock.now + 7 * 24 * 60 * 60,
    });
  });
});

// --------------------------------------------------------------------------- unresolved links

describe("DynamoUnresolvedLinks", () => {
  it("stores, reads and forgets a deal's unsaved link", async () => {
    const { unresolvedLinks, dynamo } = setup();
    expect(await unresolvedLinks.get("54")).toBeUndefined();

    await unresolvedLinks.set("54", "plink_A");
    expect(await unresolvedLinks.get("54")).toBe("plink_A");
    // No expiresAt: it must stay until it's dealt with.
    expect(dynamo.items.get("unresolved#54")).not.toHaveProperty("expiresAt");

    await unresolvedLinks.delete("54");
    expect(await unresolvedLinks.get("54")).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- deal lock

describe("DynamoDealLock", () => {
  it("lets one request at a time work on a deal", async () => {
    const { dealLock } = setup();
    expect(await dealLock.acquire("54")).toBe(true);
    expect(await dealLock.acquire("54")).toBe(false);
    expect(await dealLock.acquire("58")).toBe(true); // other deals aren't affected
    await dealLock.release("54");
    expect(await dealLock.acquire("54")).toBe(true);
  });

  it("works across copies of the service (the reason it's in DynamoDB)", async () => {
    const { dynamo, clock } = setup();
    const copyA = createDynamoStorage("test-table", dynamo, { now: () => clock.now }).dealLock;
    const copyB = createDynamoStorage("test-table", dynamo, { now: () => clock.now }).dealLock;
    expect(await copyA.acquire("54")).toBe(true);
    expect(await copyB.acquire("54")).toBe(false);
  });

  it("runs out after a minute if never released, and then only the new holder's lock counts", async () => {
    const { dynamo, clock } = setup();
    const copyA = createDynamoStorage("test-table", dynamo, { now: () => clock.now }).dealLock;
    const copyB = createDynamoStorage("test-table", dynamo, { now: () => clock.now }).dealLock;
    await copyA.acquire("54"); // copy A is stopped before releasing
    clock.now += 61;
    expect(await copyB.acquire("54")).toBe(true);

    await copyA.release("54"); // copy A comes back late: must NOT remove B's lock
    expect(await copyB.acquire("54")).toBe(false);
  });
});

// --------------------------------------------------------------------------- failures

describe("when DynamoDB can't be reached", () => {
  it("throws a StorageError that names the table and what it was doing", async () => {
    const { eventStore, dealLock, unresolvedLinks, dynamo } = setup();
    dynamo.failWith = Object.assign(new Error("connect ETIMEDOUT"), { name: "TimeoutError" });

    await expect(eventStore.claim("evt_1")).rejects.toThrow(StorageError);
    await expect(dealLock.acquire("54")).rejects.toThrow(/test-table: could not lock deal 54: connect ETIMEDOUT/);
    await expect(unresolvedLinks.get("54")).rejects.toThrow(StorageError);
  });
});

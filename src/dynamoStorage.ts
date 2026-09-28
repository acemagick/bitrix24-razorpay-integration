/**
 * The shared "notebook" for AWS Lambda: the three storage contracts from
 * storage.ts, kept in ONE DynamoDB table.
 *
 * WHY DYNAMODB: on Lambda there's no permanent disk, and several copies of the
 * service can run at once, each with its own memory. A table that every copy
 * reads and writes is the only way they can all remember the same things.
 *
 * THE TABLE: one partition key, `pk` (a string), plus a "time to live"
 * attribute, `expiresAt` (Unix seconds), after which DynamoDB deletes the row by
 * itself. Three kinds of rows share the table, told apart by a prefix:
 *
 *   event#evt_ABC       a webhook event: state "processing" or "done"
 *   unresolved#54       a link created for deal 54 but never saved to it
 *   lock#54             "a link for deal 54 is being created right now"
 *
 * HOW "ONLY ONE WINS" WORKS: a conditional write. We ask DynamoDB "create this
 * row, but only if it doesn't exist (or has run out)". DynamoDB checks and
 * writes in one step, so if two copies ask at the same moment, exactly one
 * succeeds and the other gets ConditionalCheckFailedException.
 *
 * NOTE ON EXPIRY: DynamoDB deletes expired rows only eventually (it can take a
 * day or two). So the code never relies on a row being gone: it checks the
 * time itself (`lockUntil < now`).
 */

import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { StorageError, type DealLock, type EventStore, type UnresolvedLinkRecords } from "./storage.ts";

/** How long a "processing" claim protects an event. After this, a resend may take over. */
const EVENT_CLAIM_SECONDS = 5 * 60;
/** How long handled event IDs are kept. Razorpay resends for up to 24 hours. */
const EVENT_KEEP_SECONDS = 7 * 24 * 60 * 60;
/** How long a deal lock lasts if it's never released (e.g. Lambda was stopped mid-way). */
const DEAL_LOCK_SECONDS = 60;

/** Just the part of the DynamoDB client we use, so tests can pass a fake. */
export interface DocumentClient {
  send(command: PutCommand | GetCommand | DeleteCommand): Promise<unknown>;
}

export interface DynamoOptions {
  /** Current time in Unix seconds. Tests replace it to move the clock. */
  now?: () => number;
}

const unixNow = () => Math.floor(Date.now() / 1000);

// The condition expressions we use. `#state` and `#owner` stand in for the
// attribute names, because STATE and OWNER are reserved words in DynamoDB.
export const CONDITIONS = {
  /** Claim an event: no row yet, or an abandoned "processing" claim. */
  claimEvent: "attribute_not_exists(pk) OR (#state = :processing AND lockUntil < :now)",
  /** Release an event claim, but never delete a "done" record. */
  releaseEvent: "#state = :processing",
  /** Take a deal lock: nobody holds it, or the holder's time ran out. */
  acquireLock: "attribute_not_exists(pk) OR lockUntil < :now",
  /** Release a deal lock, but only our own (not one someone took after ours ran out). */
  releaseLock: "#owner = :owner",
} as const;

// --------------------------------------------------------------------------- shared helpers

/** Base class: sends commands and turns AWS errors into StorageError. */
abstract class DynamoTable {
  protected readonly client: DocumentClient;
  protected readonly table: string;
  protected readonly now: () => number;

  constructor(client: DocumentClient, table: string, options: DynamoOptions = {}) {
    this.client = client;
    this.table = table;
    this.now = options.now ?? unixNow;
  }

  /**
   * Send a command. Resolves to the result, or to false when a condition wasn't
   * met ("someone else got there first"). Anything else becomes a StorageError.
   */
  protected async send<T>(command: PutCommand | GetCommand | DeleteCommand, what: string): Promise<T | false> {
    try {
      return (await this.client.send(command)) as T;
    } catch (err) {
      if ((err as Error).name === "ConditionalCheckFailedException") return false;
      throw new StorageError(`DynamoDB table ${this.table}: could not ${what}: ${(err as Error).message}`, { cause: err });
    }
  }
}

// --------------------------------------------------------------------------- events

export class DynamoEventStore extends DynamoTable implements EventStore {
  private key(eventId: string) {
    return { pk: `event#${eventId}` };
  }

  async claim(eventId: string): Promise<boolean> {
    const now = this.now();
    const result = await this.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...this.key(eventId), state: "processing", lockUntil: now + EVENT_CLAIM_SECONDS, expiresAt: now + EVENT_KEEP_SECONDS },
        ConditionExpression: CONDITIONS.claimEvent,
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":processing": "processing", ":now": now },
      }),
      `claim event ${eventId}`,
    );
    return result !== false;
  }

  async has(eventId: string): Promise<boolean> {
    // ConsistentRead: see a write made a moment ago by another copy of the service.
    const result = await this.send<{ Item?: { state?: string } }>(
      new GetCommand({ TableName: this.table, Key: this.key(eventId), ConsistentRead: true }),
      `read event ${eventId}`,
    );
    return result !== false && result.Item?.state === "done";
  }

  async complete(eventId: string): Promise<void> {
    try {
      await this.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...this.key(eventId), state: "done", expiresAt: this.now() + EVENT_KEEP_SECONDS },
        }),
        `record event ${eventId} as handled`,
      );
    } catch (err) {
      // Logged here, like the file version does, so callers can just react to it.
      console.error(`[webhook] ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Nothing to do: once complete() has resolved, DynamoDB has stored the record
   * for good. If complete() failed, the row still says "processing", so has()
   * says false and a resend is handled like an unfinished one.
   */
  async ensureSaved(): Promise<void> {}

  async release(eventId: string): Promise<void> {
    await this.send(
      new DeleteCommand({
        TableName: this.table,
        Key: this.key(eventId),
        ConditionExpression: CONDITIONS.releaseEvent,
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":processing": "processing" },
      }),
      `release event ${eventId}`,
    );
  }
}

// --------------------------------------------------------------------------- unresolved links

export class DynamoUnresolvedLinks extends DynamoTable implements UnresolvedLinkRecords {
  private key(dealId: string) {
    return { pk: `unresolved#${dealId}` };
  }

  async get(dealId: string): Promise<string | undefined> {
    const result = await this.send<{ Item?: { linkId?: string } }>(
      new GetCommand({ TableName: this.table, Key: this.key(dealId), ConsistentRead: true }),
      `read the unresolved link of deal ${dealId}`,
    );
    return result === false ? undefined : result.Item?.linkId;
  }

  // No expiresAt: these must stay until they're dealt with, however long that takes.
  async set(dealId: string, linkId: string): Promise<void> {
    await this.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...this.key(dealId), linkId, recordedAt: new Date(this.now() * 1000).toISOString() },
      }),
      `record unresolved link ${linkId} of deal ${dealId}`,
    );
  }

  async delete(dealId: string): Promise<void> {
    await this.send(
      new DeleteCommand({ TableName: this.table, Key: this.key(dealId) }),
      `forget the unresolved link of deal ${dealId}`,
    );
  }
}

// --------------------------------------------------------------------------- deal lock

export class DynamoDealLock extends DynamoTable implements DealLock {
  // Our own "ticket" for each lock we hold, so release() only removes our lock,
  // never one another copy took after ours ran out.
  private readonly owners = new Map<string, string>();

  private key(dealId: string) {
    return { pk: `lock#${dealId}` };
  }

  async acquire(dealId: string): Promise<boolean> {
    const now = this.now();
    const owner = randomUUID();
    const result = await this.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...this.key(dealId), owner, lockUntil: now + DEAL_LOCK_SECONDS, expiresAt: now + DEAL_LOCK_SECONDS + 86_400 },
        ConditionExpression: CONDITIONS.acquireLock,
        ExpressionAttributeValues: { ":now": now },
      }),
      `lock deal ${dealId}`,
    );
    if (result === false) return false;
    this.owners.set(dealId, owner);
    return true;
  }

  async release(dealId: string): Promise<void> {
    const owner = this.owners.get(dealId);
    if (!owner) return;
    this.owners.delete(dealId);
    await this.send(
      new DeleteCommand({
        TableName: this.table,
        Key: this.key(dealId),
        ConditionExpression: CONDITIONS.releaseLock,
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": owner },
      }),
      `unlock deal ${dealId}`,
    );
  }
}

// --------------------------------------------------------------------------- factory

/**
 * Build the three DynamoDB stores on one table.
 *
 * The AWS region and login come from the environment, the standard AWS way: on
 * Lambda they're provided automatically; on your computer, from `aws configure`.
 */
export function createDynamoStorage(table: string, client?: DocumentClient, options: DynamoOptions = {}) {
  // removeUndefinedValues: leave out fields that are undefined instead of failing.
  const documentClient =
    client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return {
    eventStore: new DynamoEventStore(documentClient, table, options),
    unresolvedLinks: new DynamoUnresolvedLinks(documentClient, table, options),
    dealLock: new DynamoDealLock(documentClient, table, options),
  };
}

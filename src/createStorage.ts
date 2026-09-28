/**
 * Pick where the service keeps what it remembers (see storage.ts).
 *
 *   DYNAMODB_TABLE set     -> DynamoDB: for AWS Lambda
 *   DYNAMODB_TABLE empty   -> two files under data/ and an in-memory lock:
 *                             for your computer or a single normal server
 */

import type { Config } from "./config.ts";
import { createDynamoStorage } from "./dynamoStorage.ts";
import { UnresolvedLinkStore } from "./paymentLinks.ts";
import { MemoryDealLock, type DealLock, type EventStore, type UnresolvedLinkRecords } from "./storage.ts";
import { ProcessedEventStore } from "./webhookHandler.ts";

export interface Storage {
  /** For the startup log line, e.g. "DynamoDB table b24-razorpay". */
  description: string;
  eventStore: EventStore;
  unresolvedLinks: UnresolvedLinkRecords;
  dealLock: DealLock;
  /** Wait until everything is safely stored. Called on shutdown. */
  flush(): Promise<void>;
}

/**
 * Build the storage the settings ask for. With files, previously saved records
 * are loaded first; this throws if the unresolved-links file can't be read,
 * because starting without it could allow a second payable link.
 */
export async function createStorage(config: Config): Promise<Storage> {
  if (config.dynamodbTable) {
    const stores = createDynamoStorage(config.dynamodbTable);
    return {
      description: `DynamoDB table ${config.dynamodbTable}`,
      ...stores,
      // Every DynamoDB write is finished (and permanent) once it resolves.
      flush: async () => {},
    };
  }

  const eventStore = new ProcessedEventStore(config.processedEventsPath);
  await eventStore.load(); // before accepting webhooks, so restarts remember past events
  const unresolvedLinks = new UnresolvedLinkStore(config.unresolvedLinksPath);
  await unresolvedLinks.load(); // before accepting requests, so restarts remember possibly payable links
  return {
    description: `files ${config.processedEventsPath} and ${config.unresolvedLinksPath}`,
    eventStore,
    unresolvedLinks,
    dealLock: new MemoryDealLock(),
    flush: async () => {
      await eventStore.flush();
      await unresolvedLinks.flush(); // rejects if the last save failed
    },
  };
}

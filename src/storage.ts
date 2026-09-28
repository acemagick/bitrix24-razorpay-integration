/**
 * The three things this service has to REMEMBER, described as contracts.
 *
 *   EventStore             which Razorpay webhook events have been handled
 *   UnresolvedLinkRecords  links we created but couldn't save to their deal
 *   DealLock               "a link is being created for this deal right now"
 *
 * WHY CONTRACTS: there are two ways to remember things:
 *   - on one computer or server: a file on disk, or plain memory
 *     (ProcessedEventStore, UnresolvedLinkStore, MemoryDealLock)
 *   - on AWS Lambda: a shared DynamoDB table (see dynamoStorage.ts), because
 *     Lambda has no permanent disk and may run several copies at once that
 *     can't see each other's memory
 * The rest of the code only talks to these contracts, so it doesn't care which
 * one is in use. createStorage.ts picks one based on the settings.
 *
 * MaybePromise: the file and memory versions answer some questions instantly
 * (a plain value); DynamoDB has to ask over the network (a Promise). Callers
 * always `await` the answer, which works for both.
 */

export type MaybePromise<T> = T | Promise<T>;

/** Remembers which webhook events have been handled, so a resend isn't handled twice. */
export interface EventStore {
  /**
   * Try to start handling an event. true: it's new, go ahead (then call
   * complete() or release()). false: it's already handled, or being handled
   * right now (has() tells which).
   * Must be atomic: two deliveries of the same event at once can't both get true.
   */
  claim(eventId: string): MaybePromise<boolean>;
  /** true once the event has been fully handled. */
  has(eventId: string): MaybePromise<boolean>;
  /** The event has been handled: remember it for good. */
  complete(eventId: string): Promise<void>;
  /** Make sure a handled event is permanently recorded (retrying a failed save). */
  ensureSaved(eventId: string): Promise<void>;
  /** Handling didn't finish: forget the claim, so a resend is handled again. */
  release(eventId: string): MaybePromise<void>;
}

/** Links this service created but couldn't save to their deal (see paymentLinks.ts). */
export interface UnresolvedLinkRecords {
  get(dealId: string): MaybePromise<string | undefined>;
  set(dealId: string, linkId: string): Promise<void>;
  delete(dealId: string): Promise<void>;
}

/** A "this deal is busy" lock, so a double click can't create two links at once. */
export interface DealLock {
  /** true: you have the lock. false: someone else is creating a link for this deal right now. */
  acquire(dealId: string): MaybePromise<boolean>;
  release(dealId: string): MaybePromise<void>;
}

/**
 * The shared storage (DynamoDB) couldn't be reached or refused a request.
 * Callers turn this into a clear "try again" message instead of a generic error.
 */
export class StorageError extends Error {
  override name = "StorageError";
}

/**
 * The lock for a single server: a list in memory.
 *
 * Checking and adding happen in one step with nothing in between, and Node runs
 * our code on one thread, so two requests can't both get the lock. This only
 * works while there is ONE copy of the service; on Lambda, DynamoDealLock is used.
 */
export class MemoryDealLock implements DealLock {
  private readonly busy = new Set<string>();

  acquire(dealId: string): boolean {
    if (this.busy.has(dealId)) return false;
    this.busy.add(dealId);
    return true;
  }

  release(dealId: string): void {
    this.busy.delete(dealId);
  }
}

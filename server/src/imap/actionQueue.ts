/**
 * Per-account serial action queue for IMAP mutations. Every mail-server mutation
 * (single or bulk) is enqueued here so the backend — not the frontend — drives
 * them, in submission order, one at a time per account. This is the single choke
 * point in front of the shared per-account IMAP connection.
 *
 * Reads (body prefetch, message list) intentionally do NOT go through the queue
 * so they can interleave between mutations and aren't blocked by a large bulk job.
 */

type Task<T> = () => Promise<T>;

class SerialQueue {
  // Tail of the promise chain. Each enqueued task runs after this resolves.
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  get size(): number {
    return this.depth;
  }

  enqueue<T>(task: Task<T>): Promise<T> {
    this.depth++;
    // Chain after the current tail, running regardless of whether the previous
    // task resolved or rejected so one failure can't wedge the whole queue.
    const result = this.tail.then(task, task);
    // Advance the tail on a swallowed copy so a rejection doesn't break the chain.
    this.tail = result.then(
      () => {},
      () => {},
    );
    void this.tail.finally(() => {
      this.depth--;
    });
    return result;
  }
}

const queues = new Map<string, SerialQueue>();

function queueFor(accountId: string): SerialQueue {
  let q = queues.get(accountId);
  if (!q) {
    q = new SerialQueue();
    queues.set(accountId, q);
  }
  return q;
}

/** Enqueue a mutation on the account's serial queue and await its result. */
export function enqueueAction<T>(accountId: string, task: Task<T>): Promise<T> {
  return queueFor(accountId).enqueue(task);
}

/** Number of queued + in-flight actions for an account (observability). */
export function queueDepth(accountId: string): number {
  return queues.get(accountId)?.size ?? 0;
}

// --- pending-removal tombstones ----------------------------------------------

/**
 * UIDs whose removal (archive/move/delete) has been enqueued but not yet
 * confirmed on the server. Read paths (list + sync reconcile) honor these so a
 * fetch never resurrects a message that was archived locally but whose IMAP move
 * is still queued/in-flight. Keyed by `${accountId}\n${folderPath}`.
 */
const pending = new Map<string, Set<number>>();

function pendingKey(accountId: string, path: string): string {
  return `${accountId}\n${path}`;
}

/** Mark UIDs as pending removal. Call synchronously at enqueue time. */
export function markPending(accountId: string, path: string, uids: number[]): void {
  const key = pendingKey(accountId, path);
  let set = pending.get(key);
  if (!set) {
    set = new Set();
    pending.set(key, set);
  }
  for (const uid of uids) set.add(uid);
}

/** Clear UIDs from the pending set. Call once the removal settles (success or failure). */
export function clearPending(accountId: string, path: string, uids: number[]): void {
  const key = pendingKey(accountId, path);
  const set = pending.get(key);
  if (!set) return;
  for (const uid of uids) set.delete(uid);
  if (set.size === 0) pending.delete(key);
}

/** UIDs currently pending removal in a folder (empty set if none). */
export function pendingSet(accountId: string, path: string): Set<number> {
  return pending.get(pendingKey(accountId, path)) ?? new Set();
}

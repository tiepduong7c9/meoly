import { db } from '../db/index.js';
import { syncFolders, syncFolderFull } from './sync.js';

const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 120_000);

const timers = new Map<string, NodeJS.Timeout>();
const running = new Set<string>();

/** Run one full sync pass for an account: folder list, then each folder. */
async function syncAccountOnce(accountId: string): Promise<void> {
  if (running.has(accountId)) return; // never overlap passes on one connection
  running.add(accountId);
  try {
    await syncFolders(accountId);

    // INBOX first, then the rest. Non-selectable containers (e.g. Gmail's
    // "[Gmail]") can't be opened, so they're excluded from the sync loop.
    const folders = db
      .prepare(
        `SELECT path FROM folders WHERE account_id = ? AND selectable = 1
         ORDER BY (special_use = '\\Inbox') DESC, (path = 'INBOX') DESC, path ASC`,
      )
      .all(accountId) as Array<{ path: string }>;

    for (const { path } of folders) {
      try {
        await syncFolderFull(accountId, path);
      } catch (err) {
        console.warn(`[sync] ${accountId} ${path}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.error(`[sync] account ${accountId} failed: ${(err as Error).message}`);
  } finally {
    running.delete(accountId);
  }
}

/** Start (or ensure) the periodic background sync loop for an account. */
export function scheduleAccount(accountId: string): void {
  if (timers.has(accountId)) return;
  void syncAccountOnce(accountId); // kick off immediately
  const timer = setInterval(() => void syncAccountOnce(accountId), INTERVAL_MS);
  timers.set(accountId, timer);
}

/** Trigger an out-of-band sync now (e.g. after an account is added or on demand). */
export function triggerAccountSync(accountId: string): void {
  void syncAccountOnce(accountId);
}

const folderRunning = new Set<string>();
const folderPending = new Set<string>();

/**
 * Fire-and-forget sync of a single folder, deduped so overlapping triggers
 * coalesce. If a sync is already running for the folder, a follow-up sync is
 * scheduled so mutations that arrived during the in-flight sync are not missed.
 */
export function syncFolderInBackground(accountId: string, path: string): void {
  const key = `${accountId}/${path}`;
  if (folderRunning.has(key)) {
    folderPending.add(key);
    return;
  }
  folderRunning.add(key);
  void syncFolderFull(accountId, path)
    .catch((err) => console.warn(`[sync] ${accountId} ${path}: ${(err as Error).message}`))
    .finally(() => {
      folderRunning.delete(key);
      if (folderPending.has(key)) {
        folderPending.delete(key);
        syncFolderInBackground(accountId, path);
      }
    });
}

/** Stop the loop for an account (e.g. when it is deleted). */
export function unscheduleAccount(accountId: string): void {
  const timer = timers.get(accountId);
  if (timer) {
    clearInterval(timer);
    timers.delete(accountId);
  }
}

/** Schedule background sync for every account at server startup. */
export function startBackgroundSync(): void {
  const accounts = db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>;
  for (const { id } of accounts) scheduleAccount(id);
  console.log(`background sync started for ${accounts.length} account(s), every ${INTERVAL_MS}ms`);
}

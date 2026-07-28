import { db } from '../db/index.js';
import { syncFolders } from '../imap/sync.js';
import type { FolderRow } from '../types.js';

export interface FolderView {
  path: string;
  name: string;
  specialUse: string | null;
  unseen: number;
  total: number;
  lastSyncedAt: string | null;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncError: string | null;
}

function readFolders(accountId: string): FolderView[] {
  // Non-selectable containers (e.g. Gmail's "[Gmail]") hold no mail and can't
  // be opened, so they're hidden from the client entirely.
  const rows = db
    .prepare('SELECT * FROM folders WHERE account_id = ? AND selectable = 1 ORDER BY path ASC')
    .all(accountId) as FolderRow[];
  return rows.map((r) => ({
    path: r.path,
    name: r.name,
    specialUse: r.special_use,
    unseen: r.unseen,
    total: r.total,
    lastSyncedAt: r.last_synced_at,
    syncStatus: r.sync_status,
    syncError: r.sync_error,
  }));
}

/** Return cached folders, syncing from the server first if requested or empty. */
export async function getFolders(
  accountId: string,
  refresh = false,
): Promise<FolderView[]> {
  const cached = readFolders(accountId);
  if (refresh || cached.length === 0) {
    await syncFolders(accountId);
    return readFolders(accountId);
  }
  return cached;
}

import { db } from '../db/index.js';
import { syncFolderFull } from '../imap/sync.js';
import { fetchBody } from '../imap/operations.js';
import type { MessageBody } from '../imap/operations.js';
import { pendingSet } from '../imap/actionQueue.js';
import type { MessageRow } from '../types.js';

export interface MessageSummary {
  uid: number;
  messageId: string | null;
  subject: string | null;
  fromName: string | null;
  fromAddr: string | null;
  to: string | null;
  date: string | null;
  seen: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

function toSummary(r: MessageRow): MessageSummary {
  return {
    uid: r.uid,
    messageId: r.message_id,
    subject: r.subject,
    fromName: r.from_name,
    fromAddr: r.from_addr,
    to: r.to_addrs,
    date: r.date,
    seen: r.seen === 1,
    flagged: r.flagged === 1,
    hasAttachments: r.has_attachments === 1,
  };
}

function readMessages(
  accountId: string,
  path: string,
  limit: number,
  offset: number,
): MessageSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE account_id = ? AND folder_path = ?
       ORDER BY date DESC, uid DESC LIMIT ? OFFSET ?`,
    )
    .all(accountId, path, limit, offset) as MessageRow[];
  // Hide messages whose removal is queued but not yet confirmed on the server,
  // so a fetch never resurrects something the user just archived/moved/deleted.
  const pending = pendingSet(accountId, path);
  const visible = pending.size ? rows.filter((r) => !pending.has(r.uid)) : rows;
  return visible.map(toSummary);
}

/**
 * List messages from the local cache. The background scheduler keeps the cache
 * in sync, so reads are fast and non-blocking. `refresh` forces a full folder
 * reconcile now; a folder that has never been synced is populated inline so the
 * first open isn't empty before the background loop reaches it.
 *
 * Reads are paged with `limit`/`offset` so folders with many messages load
 * incrementally as the client scrolls, rather than shipping the whole folder.
 */
export async function listMessages(
  accountId: string,
  path: string,
  opts: { limit?: number; offset?: number; refresh?: boolean } = {},
): Promise<MessageSummary[]> {
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;

  if (opts.refresh) {
    await syncFolderFull(accountId, path);
  } else {
    const folder = db
      .prepare('SELECT last_synced_at FROM folders WHERE account_id = ? AND path = ?')
      .get(accountId, path) as { last_synced_at: string | null } | undefined;
    if (!folder || folder.last_synced_at == null) {
      try {
        await syncFolderFull(accountId, path);
      } catch {
        // Fall back to whatever is cached; status reflects the error.
      }
    }
  }
  return readMessages(accountId, path, limit, offset);
}

export interface MessageDetail extends MessageSummary {
  body: MessageBody;
}

export async function getMessage(
  accountId: string,
  path: string,
  uid: number,
): Promise<MessageDetail | null> {
  const row = db
    .prepare('SELECT * FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?')
    .get(accountId, path, uid) as MessageRow | undefined;

  const body = await fetchBody(accountId, path, uid);
  if (!row) {
    // Not in cache (e.g. deep-linked) — still return the body we fetched.
    return {
      uid,
      messageId: null,
      subject: null,
      fromName: null,
      fromAddr: null,
      to: null,
      date: null,
      seen: true,
      flagged: false,
      hasAttachments: body.attachments.length > 0,
      body,
    };
  }
  return { ...toSummary(row), body };
}

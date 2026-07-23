import { simpleParser } from 'mailparser';
import { db } from '../db/index.js';
import { withMailbox } from './pool.js';
import { resolveSpecialFolder } from './special.js';
import type { Attachment, BodyRow } from '../types.js';

const removeCachedMessage = db.prepare(
  'DELETE FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?',
);
const removeCachedBody = db.prepare(
  'DELETE FROM bodies WHERE account_id = ? AND folder_path = ? AND uid = ?',
);
const setSeen = db.prepare(
  `UPDATE messages SET seen = @seen, flags = @flags WHERE account_id = @account_id
   AND folder_path = @folder_path AND uid = @uid`,
);

const adjustFolderCounts = db.prepare(
  `UPDATE folders SET total = MAX(0, total + @totalDelta), unseen = MAX(0, unseen + @unseenDelta)
   WHERE account_id = @account_id AND path = @path`,
);

/** Remove a message from the local cache and keep the folder counts consistent. */
function dropFromCache(accountId: string, path: string, uid: number): void {
  const row = db
    .prepare('SELECT seen FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?')
    .get(accountId, path, uid) as { seen: number } | undefined;
  removeCachedMessage.run(accountId, path, uid);
  removeCachedBody.run(accountId, path, uid);
  if (row) {
    adjustFolderCounts.run({
      account_id: accountId,
      path,
      totalDelta: -1,
      unseenDelta: row.seen === 1 ? 0 : -1,
    });
  }
}

/** Mark a message read/unread by toggling the \Seen flag. */
export async function markSeen(
  accountId: string,
  path: string,
  uid: number,
  seen: boolean,
): Promise<void> {
  await withMailbox(accountId, path, async (client) => {
    if (seen) {
      await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
    } else {
      await client.messageFlagsRemove({ uid: String(uid) }, ['\\Seen'], { uid: true });
    }
  });

  const current = db
    .prepare('SELECT flags, seen FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?')
    .get(accountId, path, uid) as { flags: string | null; seen: number } | undefined;
  const flags = new Set<string>(current?.flags ? JSON.parse(current.flags) : []);
  if (seen) flags.add('\\Seen');
  else flags.delete('\\Seen');
  setSeen.run({
    account_id: accountId,
    folder_path: path,
    uid,
    seen: seen ? 1 : 0,
    flags: JSON.stringify(Array.from(flags)),
  });

  // Keep the folder's unread count in step when the read state actually flips.
  const wasSeen = current?.seen === 1;
  if (current && wasSeen !== seen) {
    adjustFolderCounts.run({
      account_id: accountId,
      path,
      totalDelta: 0,
      unseenDelta: seen ? -1 : 1,
    });
  }
}

/** Move a message to another folder. Returns the destination path. */
export async function moveMessage(
  accountId: string,
  path: string,
  uid: number,
  target: string,
): Promise<string> {
  await withMailbox(accountId, path, async (client) => {
    await client.messageMove({ uid: String(uid) }, target, { uid: true });
  });
  dropFromCache(accountId, path, uid);
  return target;
}

/** Archive: move to the resolved \Archive folder. */
export async function archiveMessage(
  accountId: string,
  path: string,
  uid: number,
): Promise<string> {
  const target = await withMailbox(accountId, path, async (client) => {
    const dest = await resolveSpecialFolder(client, '\\Archive');
    if (!dest) throw new Error('No Archive folder found on this account');
    if (dest === path) return dest;
    await client.messageMove({ uid: String(uid) }, dest, { uid: true });
    return dest;
  });
  dropFromCache(accountId, path, uid);
  return target;
}

/**
 * Delete a message. By default moves it to Trash; with `hard`, permanently
 * expunges it (or when already in the Trash folder).
 */
export async function deleteMessage(
  accountId: string,
  path: string,
  uid: number,
  hard: boolean,
): Promise<{ trashed: boolean; target?: string }> {
  const result = await withMailbox(accountId, path, async (client) => {
    const trash = await resolveSpecialFolder(client, '\\Trash');
    const alreadyInTrash = trash != null && trash === path;

    if (hard || alreadyInTrash || !trash) {
      await client.messageDelete({ uid: String(uid) }, { uid: true });
      return { trashed: false as const };
    }
    await client.messageMove({ uid: String(uid) }, trash, { uid: true });
    return { trashed: true as const, target: trash };
  });
  dropFromCache(accountId, path, uid);
  return result;
}

export interface MessageBody {
  html: string | null;
  text: string | null;
  attachments: Attachment[];
}

/** Fetch (and cache) the parsed body of a message. Does not change read state. */
export async function fetchBody(
  accountId: string,
  path: string,
  uid: number,
): Promise<MessageBody> {
  const cached = db
    .prepare('SELECT * FROM bodies WHERE account_id = ? AND folder_path = ? AND uid = ?')
    .get(accountId, path, uid) as BodyRow | undefined;
  if (cached) {
    return {
      html: cached.html,
      text: cached.text,
      attachments: cached.attachments_json ? JSON.parse(cached.attachments_json) : [],
    };
  }

  const body = await withMailbox(accountId, path, async (client): Promise<MessageBody> => {
    // BODY.PEEK — fetching the source must NOT set \Seen.
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || typeof msg === 'boolean' || !msg.source) {
      throw new Error('Message source not available');
    }
    const parsed = await simpleParser(msg.source);
    const attachments: Attachment[] = (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
    }));
    return {
      html: parsed.html || null,
      text: parsed.text ?? null,
      attachments,
    };
  });

  db.prepare(
    `INSERT INTO bodies (account_id, folder_path, uid, html, text, attachments_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, folder_path, uid) DO UPDATE SET
       html = excluded.html, text = excluded.text,
       attachments_json = excluded.attachments_json, fetched_at = datetime('now')`,
  ).run(
    accountId,
    path,
    uid,
    body.html,
    body.text,
    JSON.stringify(body.attachments),
  );

  return body;
}

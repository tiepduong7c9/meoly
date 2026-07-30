import { simpleParser } from 'mailparser';
import { db } from '../db/index.js';
import { withMailbox } from './pool.js';
import { resolveSpecialFolder } from './special.js';
import { clearPending, enqueueAction, markPending } from './actionQueue.js';
import type { Attachment, BodyRow } from '../types.js';

// Max UIDs per IMAP command; keeps the sequence-set string bounded on huge selections.
const UID_CHUNK = 200;

function chunkUids(uids: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < uids.length; i += UID_CHUNK) out.push(uids.slice(i, i + UID_CHUNK));
  return out;
}

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

const getSeenStmt = db.prepare(
  'SELECT flags, seen FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?',
);

/** Remove many messages from the local cache in one transaction, keeping counts consistent. */
const dropManyFromCache = db.transaction((accountId: string, path: string, uids: number[]) => {
  let total = 0;
  let unseen = 0;
  for (const uid of uids) {
    const row = getSeenStmt.get(accountId, path, uid) as { seen: number } | undefined;
    if (!row) continue;
    total++;
    if (row.seen !== 1) unseen++;
    removeCachedMessage.run(accountId, path, uid);
    removeCachedBody.run(accountId, path, uid);
  }
  if (total > 0) {
    adjustFolderCounts.run({ account_id: accountId, path, totalDelta: -total, unseenDelta: -unseen });
  }
});

/** Toggle \Seen for many messages in the local cache, adjusting the unread count once. */
const setSeenManyInCache = db.transaction(
  (accountId: string, path: string, uids: number[], seen: boolean) => {
    let flipped = 0;
    for (const uid of uids) {
      const current = getSeenStmt.get(accountId, path, uid) as
        | { flags: string | null; seen: number }
        | undefined;
      if (!current) continue;
      const flags = new Set<string>(current.flags ? JSON.parse(current.flags) : []);
      if (seen) flags.add('\\Seen');
      else flags.delete('\\Seen');
      setSeen.run({
        account_id: accountId,
        folder_path: path,
        uid,
        seen: seen ? 1 : 0,
        flags: JSON.stringify(Array.from(flags)),
      });
      if ((current.seen === 1) !== seen) flipped++;
    }
    if (flipped > 0) {
      adjustFolderCounts.run({
        account_id: accountId,
        path,
        totalDelta: 0,
        unseenDelta: seen ? -flipped : flipped,
      });
    }
  },
);

const listUnseenUids = db.prepare(
  'SELECT uid FROM messages WHERE account_id = ? AND folder_path = ? AND seen = 0',
);
const zeroFolderUnseen = db.prepare(
  'UPDATE folders SET unseen = 0 WHERE account_id = ? AND path = ?',
);

/** Mark every cached unseen row in a folder as seen and zero its unread count. */
const markAllSeenInCache = db.transaction((accountId: string, path: string) => {
  const rows = listUnseenUids.all(accountId, path) as { uid: number }[];
  for (const { uid } of rows) {
    const current = getSeenStmt.get(accountId, path, uid) as
      | { flags: string | null; seen: number }
      | undefined;
    if (!current) continue;
    const flags = new Set<string>(current.flags ? JSON.parse(current.flags) : []);
    flags.add('\\Seen');
    setSeen.run({
      account_id: accountId,
      folder_path: path,
      uid,
      seen: 1,
      flags: JSON.stringify(Array.from(flags)),
    });
  }
  // Set to 0 outright rather than by delta: the server's unseen total may exceed
  // the cached unseen rows (unsynced mail), and after this op none remain unread.
  zeroFolderUnseen.run(accountId, path);
});

/**
 * Mark an entire folder read by adding \Seen to every unseen message in one
 * search-based IMAP command, then reconcile the local cache. No-ops server-side
 * when nothing is unread.
 */
export async function markAllSeen(accountId: string, path: string): Promise<void> {
  await enqueueAction(accountId, async () => {
    await withMailbox(accountId, path, async (client) => {
      // Search query { seen: false } targets UNSEEN; no UID list to enumerate.
      await client.messageFlagsAdd({ seen: false }, ['\\Seen']);
    });
  });
  markAllSeenInCache(accountId, path);
}

/**
 * Mark many messages read/unread by toggling \Seen. Batched into one IMAP
 * command per chunk, serialized through the account action queue.
 */
export async function markSeenMany(
  accountId: string,
  path: string,
  uids: number[],
  seen: boolean,
): Promise<void> {
  if (uids.length === 0) return;
  await enqueueAction(accountId, async () => {
    for (const chunk of chunkUids(uids)) {
      const seq = chunk.join(',');
      await withMailbox(accountId, path, async (client) => {
        if (seen) await client.messageFlagsAdd({ uid: seq }, ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove({ uid: seq }, ['\\Seen'], { uid: true });
      });
    }
  });
  setSeenManyInCache(accountId, path, uids, seen);
}

/** Move many messages to another folder. Returns the destination path. */
export async function moveMany(
  accountId: string,
  path: string,
  uids: number[],
  target: string,
): Promise<string> {
  if (uids.length === 0) return target;
  markPending(accountId, path, uids);
  try {
    await enqueueAction(accountId, async () => {
      for (const chunk of chunkUids(uids)) {
        await withMailbox(accountId, path, (client) =>
          client.messageMove({ uid: chunk.join(',') }, target, { uid: true }),
        );
      }
    });
    dropManyFromCache(accountId, path, uids);
    return target;
  } finally {
    clearPending(accountId, path, uids);
  }
}

/** Archive many messages: move to the resolved \Archive folder. Returns the destination. */
export async function archiveMany(
  accountId: string,
  path: string,
  uids: number[],
): Promise<string> {
  if (uids.length === 0) return path;
  markPending(accountId, path, uids);
  try {
    const target = await enqueueAction(accountId, async () => {
      const dest = await withMailbox(accountId, path, (client) =>
        resolveSpecialFolder(client, '\\Archive'),
      );
      if (!dest) throw new Error('No Archive folder found on this account');
      if (dest === path) return dest;
      for (const chunk of chunkUids(uids)) {
        await withMailbox(accountId, path, (client) =>
          client.messageMove({ uid: chunk.join(',') }, dest, { uid: true }),
        );
      }
      return dest;
    });
    if (target !== path) dropManyFromCache(accountId, path, uids);
    return target;
  } finally {
    clearPending(accountId, path, uids);
  }
}

/**
 * Delete many messages. By default moves them to Trash; with `hard`, permanently
 * expunges them (or when already in the Trash folder).
 */
export async function deleteMany(
  accountId: string,
  path: string,
  uids: number[],
  hard: boolean,
): Promise<{ trashed: boolean; target?: string }> {
  if (uids.length === 0) return { trashed: false };
  markPending(accountId, path, uids);
  try {
    const result = await enqueueAction(accountId, async () => {
      const trash = await withMailbox(accountId, path, (client) =>
        resolveSpecialFolder(client, '\\Trash'),
      );
      const alreadyInTrash = trash != null && trash === path;

      if (hard || alreadyInTrash || !trash) {
        for (const chunk of chunkUids(uids)) {
          await withMailbox(accountId, path, (client) =>
            client.messageDelete({ uid: chunk.join(',') }, { uid: true }),
          );
        }
        return { trashed: false as const };
      }
      for (const chunk of chunkUids(uids)) {
        await withMailbox(accountId, path, (client) =>
          client.messageMove({ uid: chunk.join(',') }, trash, { uid: true }),
        );
      }
      return { trashed: true as const, target: trash };
    });
    dropManyFromCache(accountId, path, uids);
    return result;
  } finally {
    clearPending(accountId, path, uids);
  }
}

// Single-message variants delegate to the batched ops so every mutation — single
// or bulk — flows through the same queue with no duplicated logic.

/** Mark a message read/unread by toggling the \Seen flag. */
export function markSeen(
  accountId: string,
  path: string,
  uid: number,
  seen: boolean,
): Promise<void> {
  return markSeenMany(accountId, path, [uid], seen);
}

/** Move a message to another folder. Returns the destination path. */
export function moveMessage(
  accountId: string,
  path: string,
  uid: number,
  target: string,
): Promise<string> {
  return moveMany(accountId, path, [uid], target);
}

/** Archive: move to the resolved \Archive folder. */
export function archiveMessage(accountId: string, path: string, uid: number): Promise<string> {
  return archiveMany(accountId, path, [uid]);
}

/**
 * Delete a message. By default moves it to Trash; with `hard`, permanently
 * expunges it (or when already in the Trash folder).
 */
export function deleteMessage(
  accountId: string,
  path: string,
  uid: number,
  hard: boolean,
): Promise<{ trashed: boolean; target?: string }> {
  return deleteMany(accountId, path, [uid], hard);
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

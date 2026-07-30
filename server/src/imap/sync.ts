import { simpleParser } from 'mailparser';
import { db } from '../db/index.js';
import { getClient, withMailbox } from './pool.js';
import { pendingSet } from './actionQueue.js';
import type { Attachment } from '../types.js';

const ENVELOPE_CHUNK = 300; // UIDs per envelope fetch
const PREFETCH_BODIES_PER_CYCLE = 25; // newest bodies to download per sync pass

interface AddressObject {
  name?: string;
  address?: string;
}

function addrName(list: AddressObject[] | undefined): string | null {
  const first = list?.[0];
  if (!first) return null;
  return first.name || first.address || null;
}

function addrEmail(list: AddressObject[] | undefined): string | null {
  return list?.[0]?.address ?? null;
}

function joinAddrs(list: AddressObject[] | undefined): string | null {
  if (!list?.length) return null;
  return list
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .filter(Boolean)
    .join(', ');
}

function toIso(value: string | Date | undefined | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Recursively detect an attachment disposition in a bodyStructure node. */
function hasAttachments(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as { disposition?: string; childNodes?: unknown[] };
  if (n.disposition && n.disposition.toLowerCase() === 'attachment') return true;
  return Array.isArray(n.childNodes) ? n.childNodes.some((c) => hasAttachments(c)) : false;
}

// --- prepared statements -----------------------------------------------------

const upsertFolderMeta = db.prepare(`
  INSERT INTO folders (account_id, path, name, special_use, selectable, uidvalidity, uidnext, unseen, total)
  VALUES (@account_id, @path, @name, @special_use, @selectable, @uidvalidity, @uidnext, @unseen, @total)
  ON CONFLICT(account_id, path) DO UPDATE SET
    name = excluded.name,
    special_use = excluded.special_use,
    selectable = excluded.selectable,
    uidvalidity = excluded.uidvalidity,
    uidnext = excluded.uidnext,
    unseen = excluded.unseen,
    total = excluded.total
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (
    account_id, folder_path, uid, message_id, subject, from_name, from_addr,
    to_addrs, date, flags, seen, flagged, has_attachments, snippet, uidvalidity, synced_at
  ) VALUES (
    @account_id, @folder_path, @uid, @message_id, @subject, @from_name, @from_addr,
    @to_addrs, @date, @flags, @seen, @flagged, @has_attachments, @snippet, @uidvalidity, datetime('now')
  )
  ON CONFLICT(account_id, folder_path, uid) DO UPDATE SET
    flags = excluded.flags, seen = excluded.seen, flagged = excluded.flagged,
    synced_at = datetime('now')
`);

const updateFlags = db.prepare(`
  UPDATE messages SET flags = @flags, seen = @seen, flagged = @flagged, synced_at = datetime('now')
  WHERE account_id = @account_id AND folder_path = @folder_path AND uid = @uid
`);

const upsertBody = db.prepare(`
  INSERT INTO bodies (account_id, folder_path, uid, html, text, attachments_json)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(account_id, folder_path, uid) DO UPDATE SET
    html = excluded.html, text = excluded.text,
    attachments_json = excluded.attachments_json, fetched_at = datetime('now')
`);

const clearFolderCache = db.transaction((accountId: string, path: string) => {
  db.prepare('DELETE FROM messages WHERE account_id = ? AND folder_path = ?').run(accountId, path);
  db.prepare('DELETE FROM bodies WHERE account_id = ? AND folder_path = ?').run(accountId, path);
});

export function setFolderStatus(
  accountId: string,
  path: string,
  status: 'idle' | 'syncing' | 'error',
  error: string | null = null,
): void {
  db.prepare(
    `UPDATE folders SET sync_status = ?, sync_error = ? WHERE account_id = ? AND path = ?`,
  ).run(status, error, accountId, path);
}

// --- folder list sync --------------------------------------------------------

/** Sync the folder list (paths, special-use, counts) for an account. */
export async function syncFolders(accountId: string): Promise<void> {
  const client = await getClient(accountId);
  const boxes = await client.list();

  for (const box of boxes) {
    // \Noselect / \NonExistent boxes (e.g. Gmail's "[Gmail]" container) hold no
    // messages and can't be opened; record them as non-selectable and skip
    // STATUS so sync/UI can filter them out instead of erroring on open.
    const selectable = !(box.flags?.has('\\Noselect') || box.flags?.has('\\NonExistent'));

    let unseen = 0;
    let total = 0;
    let uidvalidity: number | null = null;
    let uidnext: number | null = null;
    if (selectable) {
      try {
        const status = await client.status(box.path, {
          messages: true,
          unseen: true,
          uidNext: true,
          uidValidity: true,
        });
        total = status.messages ?? 0;
        unseen = status.unseen ?? 0;
        uidnext = status.uidNext ?? null;
        uidvalidity = status.uidValidity ? Number(status.uidValidity) : null;
      } catch {
        // Some servers advertise a box as selectable but still reject STATUS.
      }
    }
    upsertFolderMeta.run({
      account_id: accountId,
      path: box.path,
      name: box.name,
      special_use: box.specialUse ?? null,
      selectable: selectable ? 1 : 0,
      uidvalidity,
      uidnext,
      unseen,
      total,
    });
  }
}

// --- full message reconciliation ---------------------------------------------

/**
 * Fully reconcile a folder's messages against the server so the local cache
 * mirrors it: inserts new messages, updates changed flags, and removes messages
 * expunged on the server. Then prefetches a bounded number of recent bodies so
 * the whole mailbox is progressively stored locally.
 */
export async function syncFolderFull(accountId: string, path: string): Promise<void> {
  setFolderStatus(accountId, path, 'syncing');
  try {
    await withMailbox(accountId, path, async (client) => {
      const mailbox = client.mailbox;
      if (!mailbox || typeof mailbox === 'boolean') return;

      const uidValidity = Number(mailbox.uidValidity);
      const exists = mailbox.exists ?? 0;

      // UIDVALIDITY change invalidates all cached UIDs for this folder.
      const cachedFolder = db
        .prepare('SELECT uidvalidity FROM folders WHERE account_id = ? AND path = ?')
        .get(accountId, path) as { uidvalidity: number | null } | undefined;
      if (cachedFolder?.uidvalidity != null && cachedFolder.uidvalidity !== uidValidity) {
        clearFolderCache(accountId, path);
      }

      db.prepare(
        `UPDATE folders SET uidvalidity = ?, uidnext = ?, total = ? WHERE account_id = ? AND path = ?`,
      ).run(uidValidity, mailbox.uidNext ? Number(mailbox.uidNext) : null, exists, accountId, path);

      if (exists === 0) {
        clearFolderCache(accountId, path);
        db.prepare('UPDATE folders SET unseen = 0 WHERE account_id = ? AND path = ?').run(
          accountId,
          path,
        );
        return;
      }

      // 1. Current server state: all UIDs and their flags (lightweight fetch).
      const serverFlags = new Map<number, string[]>();
      for await (const msg of client.fetch('1:*', { uid: true, flags: true })) {
        serverFlags.set(msg.uid, msg.flags ? Array.from(msg.flags) : []);
      }
      const serverUids = new Set(serverFlags.keys());

      // UIDs whose removal is queued but not yet confirmed on the server. They
      // are still listed by the server, so exclude them from the step-5 re-insert
      // — otherwise a mid-flight sync would resurrect a message the user just
      // archived/moved/deleted. (Step 3/4/6 stay as-is: any cached row is dropped,
      // and counts decremented, by the removal job itself.)
      const pending = pendingSet(accountId, path);

      // 2. Cached state.
      const cachedRows = db
        .prepare('SELECT uid, flags FROM messages WHERE account_id = ? AND folder_path = ?')
        .all(accountId, path) as Array<{ uid: number; flags: string | null }>;
      const cachedUids = new Set(cachedRows.map((r) => r.uid));

      // 3. Remove messages expunged on the server.
      const gone = [...cachedUids].filter((u) => !serverUids.has(u));
      if (gone.length) {
        const delMsg = db.prepare(
          'DELETE FROM messages WHERE account_id = ? AND folder_path = ? AND uid = ?',
        );
        const delBody = db.prepare(
          'DELETE FROM bodies WHERE account_id = ? AND folder_path = ? AND uid = ?',
        );
        db.transaction(() => {
          for (const uid of gone) {
            delMsg.run(accountId, path, uid);
            delBody.run(accountId, path, uid);
          }
        })();
      }

      // 4. Update flags for messages whose flags changed.
      const flagUpdates = cachedRows
        .filter((r) => serverUids.has(r.uid))
        .map((r) => ({ uid: r.uid, server: serverFlags.get(r.uid)! }))
        .filter(({ uid, server }) => {
          const before = cachedRows.find((c) => c.uid === uid)!.flags ?? '[]';
          return before !== JSON.stringify(server);
        });
      if (flagUpdates.length) {
        db.transaction(() => {
          for (const { uid, server } of flagUpdates) {
            updateFlags.run({
              account_id: accountId,
              folder_path: path,
              uid,
              flags: JSON.stringify(server),
              seen: server.includes('\\Seen') ? 1 : 0,
              flagged: server.includes('\\Flagged') ? 1 : 0,
            });
          }
        })();
      }

      // 5. Fetch envelopes for new messages (chunked), skipping pending removals.
      const newUids = [...serverUids]
        .filter((u) => !cachedUids.has(u) && !pending.has(u))
        .sort((a, b) => a - b);
      for (let i = 0; i < newUids.length; i += ENVELOPE_CHUNK) {
        const chunk = newUids.slice(i, i + ENVELOPE_CHUNK);
        const rows: Array<Record<string, unknown>> = [];
        for await (const msg of client.fetch(
          chunk.join(','),
          { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true },
          { uid: true },
        )) {
          const flags = msg.flags ? Array.from(msg.flags) : [];
          const envelope = msg.envelope;
          rows.push({
            account_id: accountId,
            folder_path: path,
            uid: msg.uid,
            message_id: envelope?.messageId ?? null,
            subject: envelope?.subject ?? null,
            from_name: addrName(envelope?.from),
            from_addr: addrEmail(envelope?.from),
            to_addrs: joinAddrs(envelope?.to),
            date: toIso(envelope?.date ?? msg.internalDate),
            flags: JSON.stringify(flags),
            seen: flags.includes('\\Seen') ? 1 : 0,
            flagged: flags.includes('\\Flagged') ? 1 : 0,
            has_attachments: hasAttachments(msg.bodyStructure) ? 1 : 0,
            snippet: null,
            uidvalidity: uidValidity,
          });
        }
        db.transaction(() => {
          for (const row of rows) insertMessage.run(row);
        })();
      }

      // 6. Recompute unseen from authoritative server flags. Counts are NOT
      //    adjusted for pending removals here — dropManyFromCache (operations.ts)
      //    owns that decrement when the removal lands. Subtracting pending here as
      //    well would double-count and leave the folder undercounted until the next
      //    sync. A pending message may briefly appear in the badge but not the list
      //    (readMessages hides it); that resolves the instant the removal completes.
      const unseen = [...serverFlags.values()].filter((f) => !f.includes('\\Seen')).length;
      db.prepare('UPDATE folders SET unseen = ? WHERE account_id = ? AND path = ?').run(
        unseen,
        accountId,
        path,
      );

    });

    // Prefetch bodies outside the sync lock so user-triggered fetches (open
    // message) can interleave between individual body downloads instead of
    // waiting for the entire prefetch batch before the lock is released.
    await prefetchBodies(accountId, path);

    db.prepare(
      `UPDATE folders SET last_synced_at = datetime('now') WHERE account_id = ? AND path = ?`,
    ).run(accountId, path);
    setFolderStatus(accountId, path, 'idle');
  } catch (err) {
    setFolderStatus(accountId, path, 'error', (err as Error).message);
    throw err;
  }
}

/** Download and cache bodies for the newest messages without a cached body. */
async function prefetchBodies(accountId: string, path: string): Promise<void> {
  const targets = db
    .prepare(
      `SELECT m.uid FROM messages m
       LEFT JOIN bodies b
         ON b.account_id = m.account_id AND b.folder_path = m.folder_path AND b.uid = m.uid
       WHERE m.account_id = ? AND m.folder_path = ? AND b.uid IS NULL
       ORDER BY m.date DESC, m.uid DESC LIMIT ?`,
    )
    .all(accountId, path, PREFETCH_BODIES_PER_CYCLE) as Array<{ uid: number }>;

  for (const { uid } of targets) {
    try {
      // Hold the lock only for the network fetch; release before parsing and
      // writing so CPU-heavy simpleParser doesn't block concurrent user ops.
      const source = await withMailbox(accountId, path, async (client) => {
        // BODY.PEEK — must not set \Seen.
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || typeof msg === 'boolean' || !msg.source) return null;
        return msg.source;
      });
      if (!source) continue;
      const parsed = await simpleParser(source);
      const attachments: Attachment[] = (parsed.attachments ?? []).map((a) => ({
        filename: a.filename ?? null,
        contentType: a.contentType,
        size: a.size,
      }));
      upsertBody.run(
        accountId,
        path,
        uid,
        parsed.html || null,
        parsed.text ?? null,
        JSON.stringify(attachments),
      );
    } catch {
      // Skip a body that fails to fetch/parse; it'll be retried next cycle.
    }
  }
}

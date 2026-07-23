import { ImapFlow, type MailboxLockObject } from 'imapflow';
import { db } from '../db/index.js';
import { decrypt } from '../crypto/secrets.js';
import type { AccountRow } from '../types.js';

interface Pooled {
  client: ImapFlow;
  connecting: Promise<void> | null;
}

const pool = new Map<string, Pooled>();

function loadAccount(accountId: string): AccountRow {
  const row = db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(accountId) as AccountRow | undefined;
  if (!row) throw new Error(`Account ${accountId} not found`);
  return row;
}

function build(account: AccountRow): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure === 1,
    auth: { user: account.username, pass: decrypt(account.secret_enc) },
    logger: false,
    // Keep the single connection alive between requests.
    maxIdleTime: 60_000,
  });
}

/** Get a connected ImapFlow client for the account, reusing the pooled one. */
export async function getClient(accountId: string): Promise<ImapFlow> {
  let entry = pool.get(accountId);

  if (entry && entry.client.usable) {
    if (entry.connecting) await entry.connecting;
    return entry.client;
  }

  // Stale/absent — (re)create.
  if (entry && !entry.client.usable) {
    try {
      await entry.client.logout();
    } catch {
      /* ignore */
    }
    pool.delete(accountId);
  }

  const client = build(loadAccount(accountId));
  client.on('error', () => {
    // Drop from pool so the next call reconnects.
    if (pool.get(accountId)?.client === client) pool.delete(accountId);
  });

  entry = { client, connecting: client.connect() };
  pool.set(accountId, entry);
  try {
    await entry.connecting;
    entry.connecting = null;
  } catch (err) {
    pool.delete(accountId);
    throw err;
  }
  return client;
}

/**
 * Run `fn` against a locked mailbox on the account's single connection.
 * The lock serializes all operations so they never interleave on one socket.
 */
export async function withMailbox<T>(
  accountId: string,
  path: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = await getClient(accountId);
  const lock: MailboxLockObject = await client.getMailboxLock(path);
  try {
    return await fn(client);
  } finally {
    lock.release();
  }
}

/** Verify credentials by connecting once; used when adding an account. */
export async function testConnection(opts: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}): Promise<void> {
  const client = new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, pass: opts.pass },
    logger: false,
  });
  await client.connect();
  await client.logout();
}

/** Close and drop a pooled connection (e.g. when an account is deleted). */
export async function closeClient(accountId: string): Promise<void> {
  const entry = pool.get(accountId);
  if (!entry) return;
  pool.delete(accountId);
  try {
    await entry.client.logout();
  } catch {
    /* ignore */
  }
}

import { ImapFlow, type MailboxLockObject } from 'imapflow';
import { db } from '../db/index.js';
import { decrypt, encrypt } from '../crypto/secrets.js';
import { getAccessToken } from './oauth/microsoft.js';
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

async function buildAuth(
  account: AccountRow,
): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (account.auth_type === 'xoauth2') {
    // secret_enc holds the refresh token; exchange it for an access token and
    // persist any rotated refresh token back to the DB.
    const refreshToken = decrypt(account.secret_enc);
    const accessToken = await getAccessToken(account.id, refreshToken, (rotated) => {
      db.prepare('UPDATE accounts SET secret_enc = ? WHERE id = ?').run(
        encrypt(rotated),
        account.id,
      );
    });
    return { user: account.username, accessToken };
  }
  return { user: account.username, pass: decrypt(account.secret_enc) };
}

async function build(account: AccountRow): Promise<ImapFlow> {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure === 1,
    auth: await buildAuth(account),
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

  const client = await build(loadAccount(accountId));
  const dropFromPool = () => {
    if (pool.get(accountId)?.client === client) pool.delete(accountId);
  };
  client.on('error', dropFromPool);
  client.on('close', dropFromPool);

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

/** Verify an XOAUTH2 access token authenticates before persisting the account. */
export async function testOAuthConnection(opts: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  accessToken: string;
}): Promise<void> {
  const client = new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, accessToken: opts.accessToken },
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

import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { encrypt } from '../crypto/secrets.js';
import { testConnection, closeClient } from '../imap/pool.js';
import { clearTokenCache } from '../imap/oauth/microsoft.js';
import { scheduleAccount, unscheduleAccount } from '../imap/scheduler.js';
import type { AccountPublic, AccountRow } from '../types.js';

function toPublic(row: AccountRow): AccountPublic {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: row.port,
    secure: row.secure === 1,
    username: row.username,
    authType: row.auth_type === 'xoauth2' ? 'xoauth2' : 'password',
    createdAt: row.created_at,
  };
}

export function listAccounts(): AccountPublic[] {
  const rows = db
    .prepare('SELECT * FROM accounts ORDER BY created_at ASC')
    .all() as AccountRow[];
  return rows.map(toPublic);
}

export interface NewAccount {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

export async function createAccount(input: NewAccount): Promise<AccountPublic> {
  // Validate credentials before persisting anything.
  await testConnection({
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.username,
    pass: input.password,
  });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO accounts (id, label, host, port, secure, username, secret_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.label,
    input.host,
    input.port,
    input.secure ? 1 : 0,
    input.username,
    encrypt(input.password),
  );

  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow;
  // Begin background sync immediately for the new mailbox.
  scheduleAccount(id);
  return toPublic(row);
}

export interface NewOAuthAccount {
  label: string;
  host: string;
  port: number;
  secure: boolean;
  username: string; // mailbox email from the OAuth id_token
  refreshToken: string;
  provider: 'microsoft';
}

/**
 * Persist (or re-authenticate) an OAuth account. secret_enc holds the encrypted
 * refresh token. Signing in again for the same mailbox updates the stored token
 * rather than creating a duplicate.
 */
export function createOAuthAccount(input: NewOAuthAccount): AccountPublic {
  const existing = db
    .prepare("SELECT * FROM accounts WHERE username = ? AND auth_type = 'xoauth2'")
    .get(input.username) as AccountRow | undefined;

  if (existing) {
    db.prepare('UPDATE accounts SET secret_enc = ?, host = ?, port = ?, secure = ? WHERE id = ?').run(
      encrypt(input.refreshToken),
      input.host,
      input.port,
      input.secure ? 1 : 0,
      existing.id,
    );
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(existing.id) as AccountRow;
    scheduleAccount(existing.id);
    return toPublic(row);
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO accounts (id, label, host, port, secure, username, secret_enc, auth_type, oauth_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'xoauth2', ?)`,
  ).run(
    id,
    input.label,
    input.host,
    input.port,
    input.secure ? 1 : 0,
    input.username,
    encrypt(input.refreshToken),
    input.provider,
  );

  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow;
  scheduleAccount(id);
  return toPublic(row);
}

export async function deleteAccount(id: string): Promise<boolean> {
  unscheduleAccount(id);
  await closeClient(id);
  clearTokenCache(id);
  const info = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  return info.changes > 0;
}

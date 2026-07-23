import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { encrypt } from '../crypto/secrets.js';
import { testConnection, closeClient } from '../imap/pool.js';
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

export async function deleteAccount(id: string): Promise<boolean> {
  unscheduleAccount(id);
  await closeClient(id);
  const info = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  return info.changes > 0;
}

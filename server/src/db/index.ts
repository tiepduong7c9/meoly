import fs from 'node:fs';
import Database from 'better-sqlite3';
import { env } from '../env.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  secure      INTEGER NOT NULL DEFAULT 1,
  username    TEXT NOT NULL,
  secret_enc  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  account_id     TEXT NOT NULL,
  path           TEXT NOT NULL,
  name           TEXT NOT NULL,
  special_use    TEXT,
  uidvalidity    INTEGER,
  uidnext        INTEGER,
  unseen         INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  sync_status    TEXT NOT NULL DEFAULT 'idle',
  sync_error     TEXT,
  PRIMARY KEY (account_id, path),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  account_id       TEXT NOT NULL,
  folder_path      TEXT NOT NULL,
  uid              INTEGER NOT NULL,
  message_id       TEXT,
  subject          TEXT,
  from_name        TEXT,
  from_addr        TEXT,
  to_addrs         TEXT,
  date             TEXT,
  flags            TEXT,
  seen             INTEGER NOT NULL DEFAULT 0,
  flagged          INTEGER NOT NULL DEFAULT 0,
  has_attachments  INTEGER NOT NULL DEFAULT 0,
  snippet          TEXT,
  uidvalidity      INTEGER NOT NULL,
  synced_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, folder_path, uid),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_folder_date
  ON messages (account_id, folder_path, date DESC);

CREATE TABLE IF NOT EXISTS bodies (
  account_id        TEXT NOT NULL,
  folder_path       TEXT NOT NULL,
  uid               INTEGER NOT NULL,
  html              TEXT,
  text              TEXT,
  attachments_json  TEXT,
  fetched_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, folder_path, uid),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
`;

fs.mkdirSync(env.dataDir, { recursive: true });

export const db = new Database(env.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

// Idempotent migrations for databases created before a column existed.
function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

ensureColumn('folders', 'last_synced_at', 'last_synced_at TEXT');
ensureColumn('folders', 'sync_status', "sync_status TEXT NOT NULL DEFAULT 'idle'");
ensureColumn('folders', 'sync_error', 'sync_error TEXT');

// Any folder left 'syncing' from a previous run is stale on boot.
db.prepare("UPDATE folders SET sync_status = 'idle' WHERE sync_status = 'syncing'").run();

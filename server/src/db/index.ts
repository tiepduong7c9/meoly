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
  selectable     INTEGER NOT NULL DEFAULT 1,
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

-- Per-account AI triage policy. Rows are created lazily from env defaults the
-- first time an account is triaged, so existing accounts keep working.
CREATE TABLE IF NOT EXISTS ai_account_settings (
  account_id           TEXT PRIMARY KEY,
  enabled              INTEGER NOT NULL DEFAULT 1,
  target_folders       TEXT NOT NULL DEFAULT '["INBOX"]',      -- JSON string[]
  auto_apply           INTEGER NOT NULL DEFAULT 0,
  auto_apply_min_conf  REAL NOT NULL DEFAULT 0.9,
  auto_apply_actions   TEXT NOT NULL DEFAULT '["mark_read"]',  -- JSON string[]
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- One row per triaged message. The UNIQUE(account,folder,uid) constraint also
-- serves as the "already processed" marker so a message is never re-classified.
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  folder_path    TEXT NOT NULL,
  uid            INTEGER NOT NULL,
  message_id     TEXT,
  subject        TEXT,
  from_addr      TEXT,
  category       TEXT,
  action         TEXT NOT NULL,                -- keep | mark_read | archive | delete
  confidence     REAL,
  reasoning      TEXT,
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
                 -- pending | approved | applied | rejected | error | superseded
  applied_action TEXT,
  source         TEXT,                          -- ai_auto | web | telegram
  dry_run        INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at    TEXT,
  applied_at     TEXT,
  UNIQUE (account_id, folder_path, uid),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_suggestions_status
  ON ai_suggestions (status, created_at DESC);

-- Persisted TOTP replay guard. Rows survive server restarts so a captured code
-- cannot be replayed after a crash/redeploy within the same 30-second window.
-- Each row is keyed by (window, code) where window = floor(epoch_ms / 30000).
-- Entries older than 2 windows are deleted after each successful login.
CREATE TABLE IF NOT EXISTS used_totp_codes (
  window INTEGER NOT NULL,
  code   TEXT NOT NULL,
  PRIMARY KEY (window, code)
);

-- Singleton global config for AI + Telegram. Overrides env vars at runtime so
-- the user can reconfigure without restarting the container.
CREATE TABLE IF NOT EXISTS ai_global_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  paused              INTEGER NOT NULL DEFAULT 0,
  llm_api_base_url    TEXT,   -- NULL → use AI_API_BASE_URL env
  llm_api_key         TEXT,   -- NULL → use AI_API_KEY env
  llm_model           TEXT,   -- NULL → use AI_MODEL env
  telegram_bot_token  TEXT,   -- NULL → use TELEGRAM_BOT_TOKEN env
  telegram_chat_id    TEXT    -- NULL → use TELEGRAM_CHAT_ID env
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

ensureColumn('folders', 'selectable', 'selectable INTEGER NOT NULL DEFAULT 1');
ensureColumn('folders', 'last_synced_at', 'last_synced_at TEXT');
ensureColumn('folders', 'sync_status', "sync_status TEXT NOT NULL DEFAULT 'idle'");
ensureColumn('folders', 'sync_error', 'sync_error TEXT');

// OAuth accounts store an encrypted refresh token in secret_enc instead of a
// password; auth_type distinguishes the two so pool.ts knows how to connect.
ensureColumn('accounts', 'auth_type', "auth_type TEXT NOT NULL DEFAULT 'password'");
ensureColumn('accounts', 'oauth_provider', 'oauth_provider TEXT');

// Any folder left 'syncing' from a previous run is stale on boot.
db.prepare("UPDATE folders SET sync_status = 'idle' WHERE sync_status = 'syncing'").run();

import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { env } from '../env.js';
import type {
  AiAccountSettingsRow,
  AiAction,
  AiDecisionSource,
  AiSuggestionRow,
  AiSuggestionStatus,
} from '../types.js';

// ---------------------------------------------------------------------------
// Global settings (singleton)
// ---------------------------------------------------------------------------

export interface AiGlobalSettings {
  paused: boolean;
  llmApiBaseUrl: string | null;
  llmApiKey: string | null;
  llmModel: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
}

interface AiGlobalSettingsRow {
  id: number;
  paused: number;
  llm_api_base_url: string | null;
  llm_api_key: string | null;
  llm_model: string | null;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
}

function toGlobalSettings(r: AiGlobalSettingsRow): AiGlobalSettings {
  return {
    paused: r.paused === 1,
    llmApiBaseUrl: r.llm_api_base_url,
    llmApiKey: r.llm_api_key,
    llmModel: r.llm_model,
    telegramBotToken: r.telegram_bot_token,
    telegramChatId: r.telegram_chat_id,
  };
}

const selectGlobal = db.prepare('SELECT * FROM ai_global_settings WHERE id = 1');
const upsertGlobal = db.prepare(`
  INSERT INTO ai_global_settings
    (id, paused, llm_api_base_url, llm_api_key, llm_model, telegram_bot_token, telegram_chat_id)
  VALUES (1, @paused, @llm_api_base_url, @llm_api_key, @llm_model, @telegram_bot_token, @telegram_chat_id)
  ON CONFLICT(id) DO UPDATE SET
    paused             = @paused,
    llm_api_base_url   = @llm_api_base_url,
    llm_api_key        = @llm_api_key,
    llm_model          = @llm_model,
    telegram_bot_token = @telegram_bot_token,
    telegram_chat_id   = @telegram_chat_id
`);

export function getGlobalSettings(): AiGlobalSettings {
  const row = selectGlobal.get() as AiGlobalSettingsRow | undefined;
  if (row) return toGlobalSettings(row);
  // Lazy-seed with all-null (fall back to env everywhere).
  upsertGlobal.run({ paused: 0, llm_api_base_url: null, llm_api_key: null, llm_model: null, telegram_bot_token: null, telegram_chat_id: null });
  return { paused: false, llmApiBaseUrl: null, llmApiKey: null, llmModel: null, telegramBotToken: null, telegramChatId: null };
}

/** Public-safe view of global settings: secrets replaced with isSet booleans. */
export interface AiGlobalSettingsPublic {
  paused: boolean;
  llmApiBaseUrl: string | null;
  llmApiKey: null;
  llmApiKeySet: boolean;
  llmModel: string | null;
  telegramBotToken: null;
  telegramBotTokenSet: boolean;
  telegramChatId: string | null;
}

export function getGlobalSettingsPublic(): AiGlobalSettingsPublic {
  const s = getGlobalSettings();
  return {
    paused: s.paused,
    llmApiBaseUrl: s.llmApiBaseUrl,
    llmApiKey: null,
    llmApiKeySet: s.llmApiKey != null,
    llmModel: s.llmModel,
    telegramBotToken: null,
    telegramBotTokenSet: s.telegramBotToken != null,
    telegramChatId: s.telegramChatId,
  };
}

export function updateGlobalSettings(patch: Partial<AiGlobalSettings>): AiGlobalSettings {
  const current = getGlobalSettings();
  const next = { ...current, ...patch };
  upsertGlobal.run({
    paused: next.paused ? 1 : 0,
    llm_api_base_url: next.llmApiBaseUrl,
    llm_api_key: next.llmApiKey,
    llm_model: next.llmModel,
    telegram_bot_token: next.telegramBotToken,
    telegram_chat_id: next.telegramChatId,
  });
  return next;
}

// ---------------------------------------------------------------------------
// Per-account settings
// ---------------------------------------------------------------------------

export interface AiAccountSettings {
  accountId: string;
  enabled: boolean;
  targetFolders: string[];
  autoApply: boolean;
  autoApplyMinConf: number;
  autoApplyActions: AiAction[];
}

function toSettings(row: AiAccountSettingsRow): AiAccountSettings {
  return {
    accountId: row.account_id,
    enabled: row.enabled === 1,
    targetFolders: JSON.parse(row.target_folders) as string[],
    autoApply: row.auto_apply === 1,
    autoApplyMinConf: row.auto_apply_min_conf,
    autoApplyActions: JSON.parse(row.auto_apply_actions) as AiAction[],
  };
}

const selectSettings = db.prepare(
  'SELECT * FROM ai_account_settings WHERE account_id = ?',
);

const insertSettings = db.prepare(
  `INSERT INTO ai_account_settings
     (account_id, enabled, target_folders, auto_apply, auto_apply_min_conf, auto_apply_actions)
   VALUES (@account_id, @enabled, @target_folders, @auto_apply, @auto_apply_min_conf, @auto_apply_actions)`,
);

/** Read a settings row, lazily creating one seeded from env defaults. */
export function getAccountSettings(accountId: string): AiAccountSettings {
  const existing = selectSettings.get(accountId) as AiAccountSettingsRow | undefined;
  if (existing) return toSettings(existing);

  const seeded: AiAccountSettingsRow = {
    account_id: accountId,
    enabled: 1,
    target_folders: JSON.stringify(env.ai.defaultTargetFolders),
    auto_apply: env.ai.defaultAutoApply ? 1 : 0,
    auto_apply_min_conf: env.ai.defaultAutoApplyMinConf,
    auto_apply_actions: JSON.stringify(env.ai.defaultAutoApplyActions),
  };
  insertSettings.run(seeded);
  return toSettings(seeded);
}

export interface AiAccountSettingsPatch {
  enabled?: boolean;
  targetFolders?: string[];
  autoApply?: boolean;
  autoApplyMinConf?: number;
  autoApplyActions?: AiAction[];
}

const updateSettings = db.prepare(
  `UPDATE ai_account_settings SET
     enabled = @enabled,
     target_folders = @target_folders,
     auto_apply = @auto_apply,
     auto_apply_min_conf = @auto_apply_min_conf,
     auto_apply_actions = @auto_apply_actions
   WHERE account_id = @account_id`,
);

/** Apply a partial update; ensures a row exists first. */
export function updateAccountSettings(
  accountId: string,
  patch: AiAccountSettingsPatch,
): AiAccountSettings {
  const current = getAccountSettings(accountId);
  const next: AiAccountSettings = { ...current, ...patch };
  updateSettings.run({
    account_id: accountId,
    enabled: next.enabled ? 1 : 0,
    target_folders: JSON.stringify(next.targetFolders),
    auto_apply: next.autoApply ? 1 : 0,
    auto_apply_min_conf: next.autoApplyMinConf,
    auto_apply_actions: JSON.stringify(next.autoApplyActions),
  });
  return next;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface AiSuggestion {
  id: string;
  accountId: string;
  folderPath: string;
  uid: number;
  messageId: string | null;
  subject: string | null;
  fromAddr: string | null;
  category: string | null;
  action: AiAction;
  confidence: number | null;
  reasoning: string | null;
  model: string | null;
  status: AiSuggestionStatus;
  appliedAction: AiAction | null;
  source: AiDecisionSource | null;
  dryRun: boolean;
  error: string | null;
  createdAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

export function toSuggestion(r: AiSuggestionRow): AiSuggestion {
  return {
    id: r.id,
    accountId: r.account_id,
    folderPath: r.folder_path,
    uid: r.uid,
    messageId: r.message_id,
    subject: r.subject,
    fromAddr: r.from_addr,
    category: r.category,
    action: r.action,
    confidence: r.confidence,
    reasoning: r.reasoning,
    model: r.model,
    status: r.status,
    appliedAction: r.applied_action,
    source: r.source,
    dryRun: r.dry_run === 1,
    error: r.error,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    appliedAt: r.applied_at,
  };
}

const selectByKey = db.prepare(
  'SELECT * FROM ai_suggestions WHERE account_id = ? AND folder_path = ? AND uid = ?',
);
const selectById = db.prepare('SELECT * FROM ai_suggestions WHERE id = ?');

/** True if this exact message has already been triaged (any status). */
export function hasSuggestion(accountId: string, folderPath: string, uid: number): boolean {
  return selectByKey.get(accountId, folderPath, uid) !== undefined;
}

export function getSuggestion(id: string): AiSuggestion | undefined {
  const row = selectById.get(id) as AiSuggestionRow | undefined;
  return row ? toSuggestion(row) : undefined;
}

export interface NewSuggestion {
  accountId: string;
  folderPath: string;
  uid: number;
  messageId: string | null;
  subject: string | null;
  fromAddr: string | null;
  category: string | null;
  action: AiAction;
  confidence: number | null;
  reasoning: string | null;
  model: string | null;
}

const insertSuggestion = db.prepare(
  `INSERT INTO ai_suggestions
     (id, account_id, folder_path, uid, message_id, subject, from_addr,
      category, action, confidence, reasoning, model, status)
   VALUES
     (@id, @account_id, @folder_path, @uid, @message_id, @subject, @from_addr,
      @category, @action, @confidence, @reasoning, @model, 'pending')
   ON CONFLICT(account_id, folder_path, uid) DO NOTHING`,
);

/** Persist a fresh classification as a pending suggestion. Returns it, or
 *  undefined if one already existed for this message. */
export function createSuggestion(input: NewSuggestion): AiSuggestion | undefined {
  const id = crypto.randomUUID();
  const info = insertSuggestion.run({
    id,
    account_id: input.accountId,
    folder_path: input.folderPath,
    uid: input.uid,
    message_id: input.messageId,
    subject: input.subject,
    from_addr: input.fromAddr,
    category: input.category,
    action: input.action,
    confidence: input.confidence,
    reasoning: input.reasoning,
    model: input.model,
  });
  if (info.changes === 0) return undefined;
  return getSuggestion(id);
}

const setStatus = db.prepare(
  `UPDATE ai_suggestions SET
     status = @status,
     applied_action = COALESCE(@applied_action, applied_action),
     source = COALESCE(@source, source),
     dry_run = COALESCE(@dry_run, dry_run),
     error = @error,
     reviewed_at = COALESCE(@reviewed_at, reviewed_at),
     applied_at = COALESCE(@applied_at, applied_at)
   WHERE id = @id AND status = @expected_status`,
);

export interface StatusTransition {
  status: AiSuggestionStatus;
  expectedStatus?: AiSuggestionStatus;
  appliedAction?: AiAction | null;
  source?: AiDecisionSource | null;
  dryRun?: boolean | null;
  error?: string | null;
  reviewed?: boolean;
  applied?: boolean;
}

/**
 * Guarded status change: only transitions when the row is still in
 * `expectedStatus` (default 'pending'). Returns true if it changed. This is the
 * concurrency guard that lets web and Telegram race safely — the loser is a
 * no-op instead of a double-apply.
 */
export function transition(id: string, t: StatusTransition): boolean {
  const now = new Date().toISOString();
  const info = setStatus.run({
    id,
    status: t.status,
    expected_status: t.expectedStatus ?? 'pending',
    applied_action: t.appliedAction ?? null,
    source: t.source ?? null,
    dry_run: t.dryRun == null ? null : t.dryRun ? 1 : 0,
    error: t.error ?? null,
    reviewed_at: t.reviewed ? now : null,
    applied_at: t.applied ? now : null,
  });
  return info.changes > 0;
}

const listAllStmt = db.prepare(
  'SELECT * FROM ai_suggestions ORDER BY created_at DESC LIMIT ?',
);
const listByStatusStmt = db.prepare(
  'SELECT * FROM ai_suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ?',
);
const listByAccountStmt = db.prepare(
  'SELECT * FROM ai_suggestions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?',
);
const listByStatusAndAccountStmt = db.prepare(
  'SELECT * FROM ai_suggestions WHERE status = ? AND account_id = ? ORDER BY created_at DESC LIMIT ?',
);

export function listSuggestions(opts: {
  status?: AiSuggestionStatus;
  accountId?: string;
  limit?: number;
} = {}): AiSuggestion[] {
  const limit = opts.limit ?? 200;
  let rows: AiSuggestionRow[];
  if (opts.status && opts.accountId) {
    rows = listByStatusAndAccountStmt.all(opts.status, opts.accountId, limit) as AiSuggestionRow[];
  } else if (opts.status) {
    rows = listByStatusStmt.all(opts.status, limit) as AiSuggestionRow[];
  } else if (opts.accountId) {
    rows = listByAccountStmt.all(opts.accountId, limit) as AiSuggestionRow[];
  } else {
    rows = listAllStmt.all(limit) as AiSuggestionRow[];
  }
  return rows.map(toSuggestion);
}

const supersedeStale = db.prepare(
  `UPDATE ai_suggestions SET status = 'superseded'
   WHERE account_id = ? AND status = 'pending'
     AND NOT EXISTS (
       SELECT 1 FROM messages m
       WHERE m.account_id = ai_suggestions.account_id
         AND m.folder_path = ai_suggestions.folder_path
         AND m.uid = ai_suggestions.uid
         AND m.seen = 0
     )`,
);

/**
 * Mark pending suggestions superseded when their message is no longer unread in
 * the cache — i.e. the user read/moved/deleted it directly. Keeps the review
 * queue from showing phantoms and from applying actions to stale UIDs. Returns
 * the number superseded.
 */
export function supersedeResolved(accountId: string): number {
  return supersedeStale.run(accountId).changes;
}

const countByStatusStmt = db.prepare(
  'SELECT status, COUNT(*) as n FROM ai_suggestions GROUP BY status',
);

export function countByStatus(): Record<string, number> {
  const rows = countByStatusStmt.all() as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

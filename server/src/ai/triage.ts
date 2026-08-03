import { db } from '../db/index.js';
import { env } from '../env.js';
import { fetchBody } from '../imap/operations.js';
import type { MessageRow } from '../types.js';
import { classify } from './classifier.js';
import { ConcurrencyQueue } from './queue.js';
import { applyDecision, qualifiesForAutoApply } from './executor.js';
import {
  createSuggestion,
  getAccountSettings,
  getGlobalSettings,
  getSuggestion,
  hasSuggestion,
  supersedeResolved,
  type AiAccountSettings,
  type AiSuggestion,
} from './store.js';

const queue = new ConcurrencyQueue(env.ai.concurrency);

export function queueDepth(): number {
  return queue.size;
}

/** Reduce an HTML body to rough plaintext when no text/plain part exists. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const unclassifiedUnreadStmt = db.prepare(
  `SELECT m.* FROM messages m
   WHERE m.account_id = ? AND m.folder_path = ? AND m.seen = 0
     AND NOT EXISTS (
       SELECT 1 FROM ai_suggestions s
       WHERE s.account_id = m.account_id AND s.folder_path = m.folder_path AND s.uid = m.uid
     )
   ORDER BY m.date DESC
   LIMIT ?`,
);

/** Unread messages in a folder that have not yet been triaged. */
function unclassifiedUnread(accountId: string, folder: string, limit: number): MessageRow[] {
  return unclassifiedUnreadStmt.all(accountId, folder, limit) as MessageRow[];
}

async function triageMessage(
  msg: MessageRow,
  settings: AiAccountSettings,
  model: string,
  systemPrompt: string | null,
): Promise<AiSuggestion | undefined> {
  // Skip if it was triaged between the query and now (concurrent pass).
  if (hasSuggestion(msg.account_id, msg.folder_path, msg.uid)) return undefined;

  const body = await fetchBody(msg.account_id, msg.folder_path, msg.uid); // BODY.PEEK
  const text = body.text ?? (body.html ? htmlToText(body.html) : null);

  const result = await classify(
    {
      subject: msg.subject,
      fromName: msg.from_name,
      fromAddr: msg.from_addr,
      folder: msg.folder_path,
      body: text,
    },
    { systemPrompt, instructions: settings.customInstructions },
  );

  const created = createSuggestion({
    accountId: msg.account_id,
    folderPath: msg.folder_path,
    uid: msg.uid,
    messageId: msg.message_id,
    subject: msg.subject,
    fromAddr: msg.from_addr,
    category: result.category,
    action: result.action,
    confidence: result.confidence,
    reasoning: result.reasoning,
    model,
  });
  if (!created) return undefined;

  if (qualifiesForAutoApply(settings, created)) {
    await applyDecision(created.id, created.action, 'ai_auto');
    return getSuggestion(created.id) ?? created;
  }
  return created;
}

export interface TriageResult {
  accountId: string;
  scanned: number;
  created: AiSuggestion[];
  errors: number;
}

/**
 * Triage the unread mail of one account across its configured folders. Each
 * message is classified through the shared concurrency queue. New pending
 * suggestions are returned (auto-apply and notification are layered on later).
 */
export async function triageAccount(
  accountId: string,
  opts: { perFolderLimit?: number } = {},
): Promise<TriageResult> {
  const settings = getAccountSettings(accountId);
  const result: TriageResult = { accountId, scanned: 0, created: [], errors: 0 };
  if (!env.ai.enabled || !settings.enabled) return result;
  const gs = getGlobalSettings();
  if (gs.paused) return result;

  // Retire suggestions whose message the user already handled elsewhere.
  supersedeResolved(accountId);

  const resolvedModel = gs.llmModel ?? env.ai.model;
  const resolvedPrompt = gs.classifyPrompt;
  const limit = opts.perFolderLimit ?? 50;
  for (const folder of settings.targetFolders) {
    const messages = unclassifiedUnread(accountId, folder, limit);
    result.scanned += messages.length;

    const tasks = messages.map((msg) =>
      queue
        .run(() => triageMessage(msg, settings, resolvedModel, resolvedPrompt))
        .then((s) => {
          if (s) result.created.push(s);
        })
        .catch((err) => {
          result.errors++;
          console.warn(
            `[ai] triage ${accountId} ${folder} uid=${msg.uid}: ${(err as Error).message}`,
          );
        }),
    );
    await Promise.all(tasks);
  }
  return result;
}

let activePass: Promise<TriageResult[]> | null = null;

async function runAllAccounts(): Promise<TriageResult[]> {
  const accounts = db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>;
  const out: TriageResult[] = [];
  for (const { id } of accounts) {
    out.push(await triageAccount(id));
  }
  return out;
}

/**
 * Triage every account that has AI enabled. Deduped: if a pass is already in
 * flight (e.g. the scheduler tick and a manual `/run` overlap), callers share
 * the same pass instead of double-fetching and re-classifying the same mail.
 */
export function triageAllAccounts(): Promise<TriageResult[]> {
  if (activePass) return activePass;
  activePass = runAllAccounts().finally(() => {
    activePass = null;
  });
  return activePass;
}

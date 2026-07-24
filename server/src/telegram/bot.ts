import { env } from '../env.js';
import { applyDecision } from '../ai/executor.js';
import { getGlobalSettings, getSuggestion, type AiSuggestion } from '../ai/store.js';
import type { TriageResult } from '../ai/triage.js';
import type { AiAction } from '../types.js';

function getTelegramConfig(): { token: string; chatId: string } | null {
  const gs = getGlobalSettings();
  const token = gs.telegramBotToken ?? env.telegram.botToken;
  const chatId = gs.telegramChatId ?? env.telegram.chatId;
  if (!token || !chatId) return null;
  return { token, chatId };
}

const ACTION_LABEL: Record<AiAction, string> = {
  keep: 'Keep',
  mark_read: 'Mark read',
  archive: 'Archive',
  delete: 'Delete',
};

const ACTION_EMOJI: Record<AiAction, string> = {
  keep: '↩️',
  mark_read: '📩',
  archive: '🗄',
  delete: '🗑',
};

export function isTelegramConfigured(): boolean {
  return getTelegramConfig() !== null;
}

// --- low-level Bot API helpers -------------------------------------------------

async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
  const cfg = getTelegramConfig();
  if (!cfg) throw new Error('Telegram not configured');
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.statusText}`);
  return data.result;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- outbound digest -----------------------------------------------------------

/** Inline keyboard: approve the suggested action, override, or dismiss. */
function keyboardFor(s: AiSuggestion) {
  const alternatives = (['mark_read', 'archive', 'delete', 'keep'] as AiAction[])
    .filter((a) => a !== s.action)
    .map((a) => ({ text: `${ACTION_EMOJI[a]} ${ACTION_LABEL[a]}`, callback_data: `${a}:${s.id}` }));
  return {
    inline_keyboard: [
      [{ text: `✅ Approve · ${ACTION_LABEL[s.action]}`, callback_data: `${s.action}:${s.id}` }],
      alternatives,
      [{ text: '🚫 Dismiss', callback_data: `reject:${s.id}` }],
    ],
  };
}

function suggestionText(s: AiSuggestion): string {
  const conf = s.confidence != null ? ` · ${Math.round(s.confidence * 100)}%` : '';
  const cat = s.category ? ` · ${esc(s.category)}` : '';
  return [
    `<b>${esc(s.subject || '(no subject)')}</b>`,
    `from ${esc(s.fromAddr || 'unknown')}`,
    `<i>suggests ${ACTION_LABEL[s.action]}${conf}${cat}</i>`,
    s.reasoning ? esc(s.reasoning) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Send one digest for a completed triage pass: a summary line, the auto-applied
 * items (informational), then one actionable message per pending suggestion.
 * No-op when Telegram isn't configured or the pass produced nothing.
 */
export async function notifyDigest(results: TriageResult[]): Promise<void> {
  if (!isTelegramConfigured()) return;

  const created = results.flatMap((r) => r.created);
  if (created.length === 0) return;

  const pending = created.filter((s) => s.status === 'pending');
  const auto = created.filter((s) => s.status === 'applied' && s.source === 'ai_auto');

  const summary = [
    `🗂 <b>Meoly triage</b> — ${created.length} new`,
    auto.length ? `${auto.length} auto-applied` : '',
    pending.length ? `${pending.length} to review` : '',
    env.ai.dryRun ? '(dry run)' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const autoLines = auto
    .map((s) => `• ${ACTION_LABEL[s.appliedAction ?? s.action]}: ${esc(s.subject || '(no subject)')}`)
    .join('\n');

  // Telegram enforces per-chat flood control (~1 msg/s). Isolate each send so a
  // single failure (e.g. a 429 on a large first batch) doesn't drop the rest,
  // and space sends out to stay under the limit.
  const send = async (body: Record<string, unknown>): Promise<void> => {
    const cfg = getTelegramConfig();
    if (!cfg) return;
    try {
      await call('sendMessage', { chat_id: cfg.chatId, parse_mode: 'HTML', ...body });
    } catch (err) {
      console.warn(`[telegram] digest send failed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1_100));
  };

  await send({ text: summary + (autoLines ? `\n${autoLines}` : '') });
  for (const s of pending) {
    await send({ text: suggestionText(s), reply_markup: keyboardFor(s) });
  }
}

// --- inbound callbacks (long polling) ------------------------------------------

interface CallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}
interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
}

function parseCallback(data: string): { action: AiAction | 'reject'; id: string } | null {
  const idx = data.indexOf(':');
  if (idx === -1) return null;
  const action = data.slice(0, idx);
  const id = data.slice(idx + 1);
  if (!['keep', 'mark_read', 'archive', 'delete', 'reject'].includes(action)) return null;
  return { action: action as AiAction | 'reject', id };
}

async function handleCallback(cq: CallbackQuery): Promise<void> {
  // Reject callbacks from any chat other than the configured one.
  const cfg = getTelegramConfig();
  if (!cfg || String(cq.message?.chat.id) !== cfg.chatId) {
    await call('answerCallbackQuery', { callback_query_id: cq.id, text: '⛔ Unauthorized' }).catch(() => {});
    return;
  }

  const parsed = cq.data ? parseCallback(cq.data) : null;
  if (!parsed) {
    await call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    return;
  }

  let toast: string;
  let resolvedLine: string;
  try {
    const before = getSuggestion(parsed.id);
    if (!before) {
      toast = 'Suggestion no longer exists';
      resolvedLine = '⚠️ expired';
    } else {
      const res = await applyDecision(parsed.id, parsed.action, 'telegram');
      if (res.alreadyResolved) {
        toast = `Already ${res.status}`;
        resolvedLine = `✔️ already ${res.status}`;
      } else if (parsed.action === 'reject') {
        toast = 'Dismissed';
        resolvedLine = '🚫 dismissed';
      } else {
        const label = ACTION_LABEL[parsed.action];
        toast = res.dryRun ? `${label} (dry run)` : label;
        resolvedLine = `✅ ${label}${res.dryRun ? ' (dry run)' : ''}`;
      }
    }
  } catch (err) {
    toast = `Failed: ${(err as Error).message}`;
    resolvedLine = `❌ ${esc((err as Error).message)}`;
  }

  await call('answerCallbackQuery', { callback_query_id: cq.id, text: toast }).catch(() => {});

  // Strip the buttons and append the outcome to the original message.
  if (cq.message) {
    await call('editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: `${resolvedLine}`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
}

let polling = false;

async function pollLoop(): Promise<void> {
  let offset = 0;
  while (polling) {
    if (!getTelegramConfig()) {
      // Config removed at runtime; stop polling.
      polling = false;
      break;
    }
    try {
      const updates = (await call('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['callback_query'],
      })) as Update[];
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) await handleCallback(u.callback_query);
      }
    } catch (err) {
      console.warn(`[telegram] poll error: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

/** Start the Telegram callback poller. No-op unless configured or already running. */
export function startTelegram(): void {
  if (!isTelegramConfigured()) {
    console.log('[telegram] not configured (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or via AI settings)');
    return;
  }
  if (polling) return;
  polling = true;
  void pollLoop();
  console.log('[telegram] callback poller started');
}

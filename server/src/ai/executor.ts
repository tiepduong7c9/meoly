import { env } from '../env.js';
import { archiveMessage, deleteMessage, markSeen } from '../imap/operations.js';
import { syncFolderInBackground } from '../imap/scheduler.js';
import { getSuggestion, transition, type AiAccountSettings, type AiSuggestion } from './store.js';
import type { AiAction, AiDecisionSource } from '../types.js';

/** Perform the IMAP side of an action — unless the global dry-run switch is on,
 *  in which case nothing is mutated. `keep` is always a no-op. */
async function performImap(s: AiSuggestion, action: AiAction): Promise<void> {
  if (env.ai.dryRun || action === 'keep') return;
  switch (action) {
    case 'mark_read':
      await markSeen(s.accountId, s.folderPath, s.uid, true);
      return;
    case 'archive': {
      const target = await archiveMessage(s.accountId, s.folderPath, s.uid);
      syncFolderInBackground(s.accountId, target);
      return;
    }
    case 'delete': {
      const res = await deleteMessage(s.accountId, s.folderPath, s.uid, false); // soft → Trash
      if (res.target) syncFolderInBackground(s.accountId, res.target);
      return;
    }
  }
}

export interface DecisionResult {
  status: AiSuggestion['status'];
  applied: boolean;
  dryRun: boolean;
  /** True when another actor (web/telegram/auto) already resolved this one. */
  alreadyResolved: boolean;
}

/**
 * Apply a decision to a suggestion. `reject` dismisses it; any concrete action
 * claims the row (pending → approved) before touching IMAP so a web/Telegram
 * race resolves to a single winner. Success ends in `applied`, IMAP failure in
 * `error`. A no-op result means someone else already resolved it.
 */
export async function applyDecision(
  id: string,
  action: AiAction | 'reject',
  source: AiDecisionSource,
): Promise<DecisionResult> {
  const s = getSuggestion(id);
  if (!s) throw new Error('Suggestion not found');

  if (action === 'reject') {
    const ok = transition(id, {
      status: 'rejected',
      expectedStatus: 'pending',
      source,
      reviewed: true,
    });
    return {
      status: ok ? 'rejected' : (getSuggestion(id)?.status ?? s.status),
      applied: false,
      dryRun: false,
      alreadyResolved: !ok,
    };
  }

  // Claim the row. If this fails, another actor got here first.
  const claimed = transition(id, {
    status: 'approved',
    expectedStatus: 'pending',
    appliedAction: action,
    source,
    reviewed: true,
  });
  if (!claimed) {
    return {
      status: getSuggestion(id)?.status ?? s.status,
      applied: false,
      dryRun: false,
      alreadyResolved: true,
    };
  }

  try {
    await performImap(s, action);
    transition(id, {
      status: 'applied',
      expectedStatus: 'approved',
      dryRun: env.ai.dryRun,
      applied: true,
    });
    return { status: 'applied', applied: true, dryRun: env.ai.dryRun, alreadyResolved: false };
  } catch (err) {
    transition(id, {
      status: 'error',
      expectedStatus: 'approved',
      error: (err as Error).message,
    });
    throw err;
  }
}

/** Whether a fresh suggestion qualifies for hands-off auto-apply. */
export function qualifiesForAutoApply(
  settings: AiAccountSettings,
  s: AiSuggestion,
): boolean {
  return (
    settings.autoApply &&
    s.confidence != null &&
    s.confidence >= settings.autoApplyMinConf &&
    settings.autoApplyActions.includes(s.action)
  );
}

import { env } from '../env.js';
import {
  archiveMany,
  archiveMessage,
  deleteMany,
  deleteMessage,
  markSeen,
  markSeenMany,
  moveMessage,
} from '../imap/operations.js';
import { syncFolderInBackground } from '../imap/scheduler.js';
import {
  findMessageLocation,
  getSuggestion,
  isTrashFolder,
  recordOverride,
  transition,
  type AiAccountSettings,
  type AiSuggestion,
} from './store.js';
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

/**
 * Apply a decision to many suggestions at once. Same-action rows in the same
 * folder are grouped so the IMAP side runs as a single batched command per group
 * (shared with the message-list bulk path). The per-row claim/transition state
 * machine mirrors applyDecision so web/Telegram/auto races still resolve to one
 * winner. Returns one result per input id, in input order.
 */
export async function applyDecisionsBatch(
  ids: string[],
  action: AiAction | 'approve' | 'reject',
  source: AiDecisionSource,
): Promise<Array<Record<string, unknown>>> {
  const results = new Map<string, Record<string, unknown>>();

  // Claimed rows awaiting their IMAP action, grouped by account+folder+action.
  interface Claimed {
    s: AiSuggestion;
    act: AiAction;
  }
  const groups = new Map<string, Claimed[]>();

  for (const id of ids) {
    const s = getSuggestion(id);
    if (!s) {
      results.set(id, { id, error: 'not found' });
      continue;
    }
    const act = action === 'approve' ? s.action : action;

    if (act === 'reject') {
      const ok = transition(id, {
        status: 'rejected',
        expectedStatus: 'pending',
        source,
        reviewed: true,
      });
      results.set(id, {
        id,
        status: ok ? 'rejected' : (getSuggestion(id)?.status ?? s.status),
        applied: false,
        dryRun: false,
        alreadyResolved: !ok,
      });
      continue;
    }

    // Claim pending → approved so a concurrent actor can't double-apply.
    const claimed = transition(id, {
      status: 'approved',
      expectedStatus: 'pending',
      appliedAction: act,
      source,
      reviewed: true,
    });
    if (!claimed) {
      results.set(id, {
        id,
        status: getSuggestion(id)?.status ?? s.status,
        applied: false,
        dryRun: false,
        alreadyResolved: true,
      });
      continue;
    }
    const key = `${s.accountId}\n${s.folderPath}\n${act}`;
    const list = groups.get(key);
    if (list) list.push({ s, act });
    else groups.set(key, [{ s, act }]);
  }

  // Apply each group with a single batched IMAP op (no-op for keep / dry-run).
  for (const claimedList of groups.values()) {
    const { accountId, folderPath } = claimedList[0].s;
    const act = claimedList[0].act;
    const uids = claimedList.map((c) => c.s.uid);
    try {
      if (!env.ai.dryRun && act !== 'keep') {
        if (act === 'mark_read') {
          await markSeenMany(accountId, folderPath, uids, true);
        } else if (act === 'archive') {
          const dest = await archiveMany(accountId, folderPath, uids);
          syncFolderInBackground(accountId, dest);
        } else if (act === 'delete') {
          const res = await deleteMany(accountId, folderPath, uids, false); // soft → Trash
          if (res.target) syncFolderInBackground(accountId, res.target);
        }
      }
      for (const { s } of claimedList) {
        transition(s.id, {
          status: 'applied',
          expectedStatus: 'approved',
          dryRun: env.ai.dryRun,
          applied: true,
        });
        results.set(s.id, {
          id: s.id,
          status: 'applied',
          applied: true,
          dryRun: env.ai.dryRun,
          alreadyResolved: false,
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      for (const { s } of claimedList) {
        transition(s.id, { status: 'error', expectedStatus: 'approved', error: message });
        results.set(s.id, { id: s.id, error: message });
      }
    }
  }

  return ids.map((id) => results.get(id) ?? { id, error: 'not found' });
}

interface Location {
  folderPath: string;
  uid: number;
  seen?: boolean;
}

/**
 * Bring a message to the end-state implied by `action`, starting from its current
 * location. The read flag is set first: it doesn't change the UID, so a following
 * move stays valid (whereas a move renames the UID and we wouldn't know the new one).
 */
async function performOverride(
  accountId: string,
  loc: Location,
  origin: string,
  action: AiAction,
): Promise<void> {
  if (action === 'keep' || action === 'mark_read') {
    const wantSeen = action === 'mark_read';
    if (loc.seen !== wantSeen) await markSeen(accountId, loc.folderPath, loc.uid, wantSeen);
    if (loc.folderPath !== origin) {
      const dest = await moveMessage(accountId, loc.folderPath, loc.uid, origin);
      syncFolderInBackground(accountId, dest);
    }
  } else if (action === 'archive') {
    const dest = await archiveMessage(accountId, loc.folderPath, loc.uid);
    syncFolderInBackground(accountId, dest);
  } else if (action === 'delete') {
    // If it already lives in Trash, a soft delete would permanently expunge it —
    // skip, since "delete" here means "move to Trash", not "destroy".
    if (!isTrashFolder(accountId, loc.folderPath)) {
      const res = await deleteMessage(accountId, loc.folderPath, loc.uid, false); // soft → Trash
      if (res.target) syncFolderInBackground(accountId, res.target);
    }
  }
  syncFolderInBackground(accountId, loc.folderPath);
}

/**
 * Override the action of an already-applied suggestion. The message has likely
 * moved (and changed UID) since the auto-action, so it is re-located by Message-ID
 * before the new action is applied from wherever it now lives. The suggestion row
 * is re-stamped with the new action; IMAP failure lands it in `error`.
 */
export async function overrideDecision(
  id: string,
  action: AiAction,
  source: AiDecisionSource,
): Promise<DecisionResult> {
  const s = getSuggestion(id);
  if (!s) throw new Error('Suggestion not found');
  if (s.status !== 'applied') throw new Error('Only applied suggestions can be overridden');

  // Resolve the target location before mutating anything. Prefer the live position
  // by Message-ID (the message may have moved and changed UID). Only fall back to
  // the original triage spot when the prior action left it in place — if the prior
  // action moved it (archive/delete) and we can't find it, acting on the stale
  // UID would silently no-op while reporting success, so fail loudly instead.
  const located = s.messageId ? findMessageLocation(s.accountId, s.messageId) : undefined;
  let loc: Location;
  if (located) {
    loc = located;
  } else if (s.appliedAction === 'archive' || s.appliedAction === 'delete') {
    throw new Error('Cannot locate the message to override; it has moved since the action');
  } else {
    loc = { folderPath: s.folderPath, uid: s.uid };
  }

  if (env.ai.dryRun) {
    recordOverride(id, action, source, true);
    return { status: 'applied', applied: false, dryRun: true, alreadyResolved: false };
  }

  // Claim the row (applied → approved) so a concurrent override can't double-apply;
  // mirrors the claim in applyDecision. The loser is a no-op, not a second mutation.
  const claimed = transition(id, {
    status: 'approved',
    expectedStatus: 'applied',
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
    await performOverride(s.accountId, loc, s.folderPath, action);
    recordOverride(id, action, source, false);
    return { status: 'applied', applied: true, dryRun: false, alreadyResolved: false };
  } catch (err) {
    transition(id, { status: 'error', expectedStatus: 'approved', error: (err as Error).message });
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

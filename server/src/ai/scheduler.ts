import { env } from '../env.js';
import { triageAllAccounts } from './triage.js';
import { notifyDigest } from '../telegram/bot.js';
import { getGlobalSettings } from './store.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Run one triage pass across all accounts, never overlapping with itself. */
async function tick(): Promise<void> {
  if (running) return;
  if (getGlobalSettings().paused) {
    console.log('[ai] triage skipped (paused)');
    return;
  }
  running = true;
  try {
    const results = await triageAllAccounts();
    const created = results.reduce((n, r) => n + r.created.length, 0);
    const errors = results.reduce((n, r) => n + r.errors, 0);
    if (created || errors) {
      console.log(`[ai] triage pass: ${created} new suggestion(s), ${errors} error(s)`);
    }
    if (created) await notifyDigest(results);
  } catch (err) {
    console.error(`[ai] triage pass failed: ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

/** Start the periodic AI triage loop. No-op unless AI is globally enabled. */
export function startAiTriage(): void {
  if (!env.ai.enabled) {
    console.log('[ai] triage disabled (AI_ENABLED=false)');
    return;
  }
  if (timer) return;
  void tick(); // kick off immediately
  timer = setInterval(() => void tick(), env.ai.pollIntervalMs);
  console.log(
    `[ai] triage started (every ${env.ai.pollIntervalMs}ms, model=${env.ai.model}, dryRun=${env.ai.dryRun})`,
  );
}

/** Trigger an out-of-band triage pass now. */
export function triggerAiTriage(): void {
  void tick();
}

import { Router } from 'express';
import { z } from 'zod';
import { env } from '../env.js';
import {
  countByStatus,
  getAccountSettings,
  getGlobalSettings,
  getGlobalSettingsPublic,
  getSuggestion,
  listSuggestions,
  updateAccountSettings,
  updateGlobalSettings,
} from '../ai/store.js';
import { applyDecision, applyDecisionsBatch, overrideDecision } from '../ai/executor.js';
import type { AiSuggestionStatus } from '../types.js';
import { queueDepth, triageAccount, triageAllAccounts } from '../ai/triage.js';
import { triggerAiTriage } from '../ai/scheduler.js';
import { startTelegram } from '../telegram/bot.js';

// Mounted at /api/ai
export const aiRouter: Router = Router();

aiRouter.get('/status', (_req, res) => {
  const gs = getGlobalSettings();
  res.json({
    enabled: env.ai.enabled,
    dryRun: env.ai.dryRun,
    model: gs.llmModel ?? env.ai.model,
    paused: gs.paused,
    queueDepth: queueDepth(),
    counts: countByStatus(),
  });
});

aiRouter.get('/suggestions', (req, res) => {
  const status = req.query.status as AiSuggestionStatus | undefined;
  const accountId = req.query.accountId as string | undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  res.json(listSuggestions({ status, accountId, limit }));
});

const runSchema = z.object({ accountId: z.string().optional() });

aiRouter.post('/run', async (req, res) => {
  if (!env.ai.enabled) {
    res.status(400).json({ error: 'AI triage is disabled (set AI_ENABLED=true)' });
    return;
  }
  const parsed = runSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Expected { accountId?: string }' });
    return;
  }
  const results = parsed.data.accountId
    ? [await triageAccount(parsed.data.accountId)]
    : await triageAllAccounts();
  res.json({ ok: true, results });
});

aiRouter.post('/trigger', (_req, res) => {
  if (!env.ai.enabled) {
    res.status(400).json({ error: 'AI triage is disabled (set AI_ENABLED=true)' });
    return;
  }
  triggerAiTriage(); // fire-and-forget; deduped against the running pass
  res.status(202).json({ ok: true });
});

const decisionSchema = z.object({
  action: z.enum(['keep', 'mark_read', 'archive', 'delete', 'reject']),
});

// Batch decision. `approve` applies each suggestion's own suggested action;
// any concrete action applies that same action to all listed suggestions.
// Registered before the `:id` route so "/decision" isn't captured as an id.
const batchSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  action: z.enum(['approve', 'keep', 'mark_read', 'archive', 'delete', 'reject']),
});

aiRouter.post('/suggestions/decision', async (req, res) => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Expected { ids: string[], action }' });
    return;
  }
  const { ids, action } = parsed.data;
  const results = await applyDecisionsBatch(ids, action, 'web');
  res.json({ ok: true, results });
});

aiRouter.post('/suggestions/:id/decision', async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Expected { action: keep|mark_read|archive|delete|reject }' });
    return;
  }
  if (!getSuggestion(req.params.id)) {
    res.status(404).json({ error: 'Suggestion not found' });
    return;
  }
  const result = await applyDecision(req.params.id, parsed.data.action, 'web');
  res.json({ ok: true, ...result });
});

const overrideSchema = z.object({
  action: z.enum(['keep', 'mark_read', 'archive', 'delete']),
});

// Re-action an already-applied suggestion (typically an auto-applied one): apply a
// different action, re-locating the message by Message-ID since it may have moved.
aiRouter.post('/suggestions/:id/override', async (req, res) => {
  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Expected { action: keep|mark_read|archive|delete }' });
    return;
  }
  if (!getSuggestion(req.params.id)) {
    res.status(404).json({ error: 'Suggestion not found' });
    return;
  }
  const result = await overrideDecision(req.params.id, parsed.data.action, 'web');
  res.json({ ok: true, ...result });
});

const optStr = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() || null) : v),
  z.string().nullable().optional(),
);

const globalSettingsSchema = z.object({
  paused: z.boolean().optional(),
  llmApiBaseUrl: optStr,
  llmApiKey: optStr,
  llmModel: optStr,
  classifyPrompt: optStr,
  telegramBotToken: optStr,
  telegramChatId: optStr,
});

aiRouter.get('/global-settings', (_req, res) => {
  res.json(getGlobalSettingsPublic());
});

aiRouter.put('/global-settings', (req, res) => {
  const parsed = globalSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid settings', details: parsed.error.issues });
    return;
  }
  updateGlobalSettings(parsed.data);
  if ('telegramBotToken' in parsed.data || 'telegramChatId' in parsed.data) {
    startTelegram();
  }
  res.json(getGlobalSettingsPublic());
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  targetFolders: z.array(z.string()).optional(),
  autoApply: z.boolean().optional(),
  autoApplyMinConf: z.number().min(0).max(1).optional(),
  autoApplyActions: z.array(z.enum(['keep', 'mark_read', 'archive', 'delete'])).optional(),
  customInstructions: optStr,
});

aiRouter.get('/accounts/:id/settings', (req, res) => {
  res.json(getAccountSettings(req.params.id));
});

aiRouter.put('/accounts/:id/settings', (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid settings', details: parsed.error.issues });
    return;
  }
  res.json(updateAccountSettings(req.params.id, parsed.data));
});

import { Router } from 'express';
import { z } from 'zod';
import { createAccount, deleteAccount, listAccounts } from '../services/accounts.js';
import { triggerAccountSync } from '../imap/scheduler.js';

export const accountsRouter: Router = Router();

const newAccountSchema = z.object({
  label: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  secure: z.boolean().default(true),
  username: z.string().min(1),
  password: z.string().min(1),
});

accountsRouter.get('/', (_req, res) => {
  res.json(listAccounts());
});

accountsRouter.post('/', async (req, res) => {
  const parsed = newAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid account', details: parsed.error.issues });
    return;
  }
  try {
    const account = await createAccount(parsed.data);
    res.status(201).json(account);
  } catch (err) {
    // ImapFlow puts the actual server response in err.response; err.message is just "Command failed".
    const detail = (err as any).response ?? (err as Error).message;
    res.status(400).json({
      error: 'Could not connect with those IMAP credentials',
      detail,
    });
  }
});

accountsRouter.post('/:id/sync', (req, res) => {
  triggerAccountSync(req.params.id);
  res.status(202).json({ ok: true });
});

accountsRouter.delete('/:id', async (req, res) => {
  const ok = await deleteAccount(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  res.status(204).end();
});

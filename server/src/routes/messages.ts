import { Router } from 'express';
import { z } from 'zod';
import { getMessage, listMessages } from '../services/messages.js';
import {
  archiveMessage,
  deleteMessage,
  markSeen,
  moveMessage,
} from '../imap/operations.js';
import { syncFolderInBackground } from '../imap/scheduler.js';

// Mounted at /api/accounts/:id/messages
export const messagesRouter: Router = Router({ mergeParams: true });

function ctx(req: { params: unknown; query: unknown }): { accountId: string; folder: string } {
  const accountId = (req.params as { id: string }).id;
  const folder = (req.query as { folder?: string }).folder;
  if (!folder) throw new HttpError(400, 'Missing required "folder" query parameter');
  return { accountId, folder };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

messagesRouter.get('/', async (req, res) => {
  const { accountId, folder } = ctx(req);
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const refresh = req.query.refresh === 'true';
  const messages = await listMessages(accountId, folder, { limit, refresh });
  res.json(messages);
});

messagesRouter.get('/:uid', async (req, res) => {
  const { accountId, folder } = ctx(req);
  const uid = Number(req.params.uid);
  const message = await getMessage(accountId, folder, uid);
  if (!message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  res.json(message);
});

const readSchema = z.object({ seen: z.boolean() });

messagesRouter.post('/:uid/read', async (req, res) => {
  const { accountId, folder } = ctx(req);
  const parsed = readSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Expected { seen: boolean }' });
    return;
  }
  await markSeen(accountId, folder, Number(req.params.uid), parsed.data.seen);
  res.json({ ok: true });
});

const moveSchema = z.object({ target: z.string().min(1) });

messagesRouter.post('/:uid/move', async (req, res) => {
  const { accountId, folder } = ctx(req);
  const parsed = moveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Expected { target: string }' });
    return;
  }
  const target = await moveMessage(accountId, folder, Number(req.params.uid), parsed.data.target);
  syncFolderInBackground(accountId, target); // refresh destination promptly
  res.json({ ok: true, target });
});

messagesRouter.post('/:uid/archive', async (req, res) => {
  const { accountId, folder } = ctx(req);
  const target = await archiveMessage(accountId, folder, Number(req.params.uid));
  syncFolderInBackground(accountId, target);
  res.json({ ok: true, target });
});

messagesRouter.delete('/:uid', async (req, res) => {
  const { accountId, folder } = ctx(req);
  const hard = req.query.hard === 'true';
  const result = await deleteMessage(accountId, folder, Number(req.params.uid), hard);
  if (result.target) syncFolderInBackground(accountId, result.target); // Trash
  res.json({ ok: true, ...result });
});

export { HttpError };

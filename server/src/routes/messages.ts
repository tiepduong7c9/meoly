import { Router } from 'express';
import { z } from 'zod';
import { getMessage, listMessages } from '../services/messages.js';
import {
  archiveMany,
  archiveMessage,
  deleteMany,
  deleteMessage,
  markSeen,
  markSeenMany,
  moveMany,
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
  const offset = req.query.offset ? Number(req.query.offset) : undefined;
  // Only page 0 triggers a full IMAP reconcile; deeper pages read the cache.
  const refresh = req.query.refresh === 'true' && !offset;
  const messages = await listMessages(accountId, folder, { limit, offset, refresh });
  res.json(messages);
});

const bulkSchema = z.object({
  action: z.enum(['read', 'unread', 'archive', 'move', 'delete']),
  uids: z.array(z.number().int().positive()).min(1),
  target: z.string().min(1).optional(),
  hard: z.boolean().optional(),
});

// Bulk action over many UIDs in one request. The backend batches them into a
// single IMAP command per chunk (via the *Many ops) and drives them through the
// per-account action queue. Registered before `/:uid` so it isn't captured as an id.
messagesRouter.post('/bulk', async (req, res) => {
  const { accountId, folder } = ctx(req);
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Expected { action: read|unread|archive|move|delete, uids: number[], target?, hard? }',
    });
    return;
  }
  const { action, uids, target, hard } = parsed.data;

  switch (action) {
    case 'read':
    case 'unread':
      await markSeenMany(accountId, folder, uids, action === 'read');
      res.json({ ok: true, count: uids.length });
      return;
    case 'archive': {
      const dest = await archiveMany(accountId, folder, uids);
      syncFolderInBackground(accountId, dest);
      res.json({ ok: true, target: dest, count: uids.length });
      return;
    }
    case 'move': {
      if (!target) {
        res.status(400).json({ error: 'move requires a target folder' });
        return;
      }
      await moveMany(accountId, folder, uids, target);
      syncFolderInBackground(accountId, target);
      res.json({ ok: true, target, count: uids.length });
      return;
    }
    case 'delete': {
      const result = await deleteMany(accountId, folder, uids, hard ?? false);
      if (result.target) syncFolderInBackground(accountId, result.target);
      res.json({ ok: true, ...result, count: uids.length });
      return;
    }
  }
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

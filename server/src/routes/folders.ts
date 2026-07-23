import { Router } from 'express';
import { getFolders } from '../services/folders.js';

// Mounted at /api/accounts/:id/folders
export const foldersRouter: Router = Router({ mergeParams: true });

foldersRouter.get('/', async (req, res) => {
  const accountId = (req.params as { id: string }).id;
  const refresh = req.query.refresh === 'true';
  const folders = await getFolders(accountId, refresh);
  res.json(folders);
});

foldersRouter.post('/sync', async (req, res) => {
  const accountId = (req.params as { id: string }).id;
  const folders = await getFolders(accountId, true);
  res.json(folders);
});

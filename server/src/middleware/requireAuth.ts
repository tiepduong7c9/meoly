import type { NextFunction, Request, Response } from 'express';
import { env } from '../env.js';
import { validateSession } from '../auth/session.js';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!env.auth.enabled) {
    next();
    return;
  }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !validateSession(token)) {
    res.status(401).json({ error: 'session_expired' });
    return;
  }
  next();
}

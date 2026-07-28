import { Router } from 'express';
import { verify } from 'otplib';
import { env } from '../env.js';
import {
  createSession,
  deleteSession,
  checkRateLimit,
  isCodeAlreadyUsed,
  recordUsedCode,
} from '../auth/session.js';

export const authRouter = Router();

// Public: lets the SPA skip the login screen when TOTP auth isn't configured.
authRouter.get('/status', (_req, res) => {
  res.json({ enabled: env.auth.enabled });
});

authRouter.post('/login', async (req, res) => {
  if (!env.auth.enabled) {
    res.status(404).json({ error: 'Auth not enabled' });
    return;
  }

  // Always use the direct socket address — ignoring X-Forwarded-For prevents
  // clients from rotating fake IPs to bypass the rate limiter.
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: 'Too many attempts — try again in 5 minutes' });
    return;
  }

  const { code } = req.body as { code?: string };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'code required' });
    return;
  }

  const normalizedCode = code.replace(/\s/g, '');

  if (isCodeAlreadyUsed(normalizedCode)) {
    res.status(401).json({ error: 'Code already used — wait for the next code' });
    return;
  }

  const result = await verify({
    secret: env.auth.totpSecret,
    token: normalizedCode,
    strategy: 'totp',
  });
  if (!result.valid) {
    res.status(401).json({ error: 'Invalid code' });
    return;
  }

  recordUsedCode(normalizedCode);
  const token = createSession();
  res.json({ token });
});

authRouter.post('/logout', (req, res) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) deleteSession(token);
  res.status(204).send();
});

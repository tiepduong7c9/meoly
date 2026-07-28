import path from 'node:path';
import fs from 'node:fs';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import { env } from './env.js';
import './db/index.js'; // initialize DB + schema on boot
import { generateURI } from 'otplib';
import { authRouter } from './routes/auth.js';
import { requireAuth } from './middleware/requireAuth.js';
import { accountsRouter } from './routes/accounts.js';
import { oauthCallbackRouter, oauthStartRouter } from './routes/oauth.js';
import { foldersRouter } from './routes/folders.js';
import { messagesRouter, HttpError } from './routes/messages.js';
import { aiRouter } from './routes/ai.js';
import { startBackgroundSync } from './imap/scheduler.js';
import { startAiTriage } from './ai/scheduler.js';
import { startTelegram } from './telegram/bot.js';

const app = express();

app.use(
  helmet({
    // Self-hosted app serving its own bundled assets; relax CSP to avoid
    // blocking the Vite build's module scripts / inline styles.
    contentSecurityPolicy: false,
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);

// The OAuth callback is a top-level browser redirect from Microsoft and carries
// no Bearer token; it is mounted before requireAuth and secured by the single-
// use `state` issued from the authed /start route.
app.use('/api/oauth', oauthCallbackRouter);

// Scope auth to API routes only — static SPA files are served without a token.
app.use('/api', requireAuth);

app.use('/api/oauth', oauthStartRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/accounts/:id/folders', foldersRouter);
app.use('/api/accounts/:id/messages', messagesRouter);
app.use('/api/ai', aiRouter);

// Serve the built SPA in production, with history-API fallback.
if (env.isProd && fs.existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(env.webDist, 'index.html'));
  });
}

// Centralized error handler.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

app.listen(env.port, () => {
  console.log(`meoly server listening on http://localhost:${env.port}`);
  console.log(`  data dir: ${env.dataDir}`);
  if (env.auth.enabled) {
    const otpauth = generateURI({
      secret: env.auth.totpSecret,
      issuer: 'Meoly',
      label: 'meoly',
      strategy: 'totp',
    });
    console.log('  auth: enabled — scan this URL with your authenticator app:');
    console.log(' ', otpauth);
  }
  startBackgroundSync();
  startAiTriage();
  startTelegram();
});

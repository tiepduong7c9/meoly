import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The dev server runs with cwd at server/, but .env lives at the monorepo root.
// Walk up from both cwd and this module's directory to find the nearest .env.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const start of [process.cwd(), here]) {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

const encryptionKeyRaw = required('ENCRYPTION_KEY');
const encryptionKey = Buffer.from(encryptionKeyRaw, 'base64');
if (encryptionKey.length !== 32) {
  throw new Error(
    'ENCRYPTION_KEY must be a base64-encoded 32-byte key. Generate one with: openssl rand -base64 32',
  );
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return v === 'true' || v === '1';
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  // Treat an unset or blank var as absent — Number('') is 0, which would
  // otherwise silently override the fallback (e.g. a 0ms poll interval).
  if (raw == null || raw.trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function csv(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v == null || v.trim() === '') return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

const totpSecret = process.env.TOTP_SECRET ?? '';
const authEnabled = bool('AUTH_ENABLED', !!totpSecret);
if (authEnabled && !totpSecret) {
  throw new Error(
    'AUTH_ENABLED=true but TOTP_SECRET is not set. Generate one with: node -e "import(\'otplib\').then(m=>console.log(m.authenticator.generateSecret()))"',
  );
}

export const env = {
  port: Number(process.env.PORT ?? 3001),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  dataDir,
  dbPath: path.join(dataDir, 'meoly.db'),
  encryptionKey,
  /** Path to the built SPA, served in production. */
  webDist: path.resolve(process.cwd(), 'web/dist'),

  /**
   * AI triage. Provider/infra settings live here (global); per-account policy
   * (folders, auto-apply thresholds) lives in the ai_account_settings table.
   * `dryRun` is a global kill-switch: when true, no IMAP mutation is performed.
   */
  ai: {
    enabled: bool('AI_ENABLED', false),
    apiBaseUrl: process.env.AI_API_BASE_URL ?? 'http://localhost:1234/v1',
    apiKey: process.env.AI_API_KEY ?? '',
    model: process.env.AI_MODEL ?? 'local-model',
    dryRun: bool('AI_DRY_RUN', !isProd()),
    concurrency: Math.max(1, num('AI_CONCURRENCY', 1)),
    requestTimeoutMs: num('AI_REQUEST_TIMEOUT_MS', 60_000),
    maxBodyChars: num('AI_MAX_BODY_CHARS', 4000),
    pollIntervalMs: num('AI_POLL_INTERVAL_MS', 300_000),
    // Defaults used to seed a per-account settings row on first sight.
    defaultTargetFolders: csv('AI_TARGET_FOLDERS', ['INBOX']),
    defaultAutoApply: bool('AI_AUTO_APPLY', false),
    defaultAutoApplyMinConf: num('AI_AUTO_APPLY_MIN_CONFIDENCE', 0.9),
    defaultAutoApplyActions: csv('AI_AUTO_APPLY_ACTIONS', ['mark_read']),
  },

  auth: {
    enabled: authEnabled,
    totpSecret,
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },

  /**
   * Microsoft OAuth2 (XOAUTH2) for Outlook/Office 365 IMAP. Enabled only when a
   * client id + secret are configured. `tenant` = 'common' supports both
   * personal and org accounts. `redirectUri` should be set explicitly in prod
   * (must exactly match the Azure app registration); when blank it is derived
   * from the incoming request, honoring reverse-proxy forwarding headers.
   */
  microsoftOAuth: {
    get enabled(): boolean {
      return !!process.env.MS_OAUTH_CLIENT_ID && !!process.env.MS_OAUTH_CLIENT_SECRET;
    },
    clientId: process.env.MS_OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.MS_OAUTH_CLIENT_SECRET ?? '',
    tenant: process.env.MS_OAUTH_TENANT ?? 'common',
    redirectUri: process.env.MS_OAUTH_REDIRECT_URI ?? '',
  },
} as const;

function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

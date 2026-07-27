import { randomBytes } from 'node:crypto';
import { db } from '../db/index.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;

const sessions = new Map<string, number>(); // token → expiry epoch ms
const loginAttempts = new Map<string, { count: number; resetAt: number }>(); // ip → attempts

// Evict expired rate-limit entries so the map doesn't grow unboundedly when the
// endpoint is hit from many distinct IPs (e.g. internet scanners).
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, RATE_WINDOW_MS);

export function createSession(): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function validateSession(token: string): boolean {
  const expiry = sessions.get(token);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function deleteSession(token: string): void {
  sessions.delete(token);
}

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_LOGIN_ATTEMPTS) return false;
  entry.count++;
  return true;
}

const stmtCodeUsed = db.prepare(
  'SELECT 1 FROM used_totp_codes WHERE (window = ? OR window = ?) AND code = ?',
);
const stmtInsertCode = db.prepare(
  'INSERT OR IGNORE INTO used_totp_codes (window, code) VALUES (?, ?)',
);
const stmtEvictCodes = db.prepare('DELETE FROM used_totp_codes WHERE window < ?');

export function isCodeAlreadyUsed(code: string): boolean {
  const win = Math.floor(Date.now() / 30_000);
  return !!stmtCodeUsed.get(win, win - 1, code);
}

export function recordUsedCode(code: string): void {
  const win = Math.floor(Date.now() / 30_000);
  // Mark the code used for both the current and previous window (otplib accepts ±1).
  stmtInsertCode.run(win, code);
  stmtInsertCode.run(win - 1, code);
  stmtEvictCodes.run(win - 2);
}

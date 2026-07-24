import { randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;

const sessions = new Map<string, number>(); // token → expiry epoch ms
const loginAttempts = new Map<string, { count: number; resetAt: number }>(); // ip → attempts
const usedTotpCodes = new Set<string>(); // `${window}:${code}` — replay guard

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

export function isCodeAlreadyUsed(code: string): boolean {
  const win = Math.floor(Date.now() / 30_000);
  return usedTotpCodes.has(`${win}:${code}`) || usedTotpCodes.has(`${win - 1}:${code}`);
}

export function recordUsedCode(code: string): void {
  const win = Math.floor(Date.now() / 30_000);
  usedTotpCodes.add(`${win}:${code}`);
  usedTotpCodes.add(`${win - 1}:${code}`);
  // Evict entries older than 2 windows
  for (const key of usedTotpCodes) {
    const w = parseInt(key.split(':')[0]);
    if (win - w > 2) usedTotpCodes.delete(key);
  }
}

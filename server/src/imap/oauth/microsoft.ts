import crypto from 'node:crypto';
import { env } from '../../env.js';

/**
 * Microsoft OAuth2 (authorization-code + PKCE) for Outlook/Office 365 IMAP.
 *
 * We store the long-lived refresh token (encrypted) and exchange it for a
 * short-lived access token before each IMAP connection. ImapFlow performs
 * XOAUTH2 automatically when given `auth: { user, accessToken }`.
 */

// IMAP.AccessAsUser.All grants IMAP; offline_access yields a refresh token;
// openid/email let us read the mailbox address from the returned id_token.
const SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'offline_access',
  'openid',
  'email',
].join(' ');

function authority(): string {
  return `https://login.microsoftonline.com/${env.microsoftOAuth.tenant}`;
}

// --- base64url helpers ---
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Pending-flow store: state -> { verifier, redirectUri } with a 10-min TTL.
// This ties an unguessable, single-use `state` to the PKCE verifier and secures
// the otherwise-public callback route.
interface Pending {
  verifier: string;
  redirectUri: string;
  createdAt: number;
}
const PENDING_TTL_MS = 10 * 60_000;
const pending = new Map<string, Pending>();

function prunePending(): void {
  const now = Date.now();
  for (const [state, p] of pending) {
    if (now - p.createdAt > PENDING_TTL_MS) pending.delete(state);
  }
}

/** Build the Microsoft authorize URL and register the pending flow. */
export function buildAuthUrl(redirectUri: string): string {
  prunePending();
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  pending.set(state, { verifier, redirectUri, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: env.microsoftOAuth.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Personal accounts sometimes need explicit consent to (re)issue a refresh
    // token; select_account avoids silently reusing a stale session.
    prompt: 'select_account',
  });
  return `${authority()}/oauth2/v2.0/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${authority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json()) as TokenResponse & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || data.error) {
    throw new Error(data.error_description || data.error || `Token request failed (${res.status})`);
  }
  return data;
}

/** Decode a JWT payload without verification (used only to read our own email). */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1] ?? '';
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface ExchangeResult {
  email: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

/**
 * Exchange an authorization code for tokens. Validates & consumes the `state`.
 * Returns the mailbox email decoded from the id_token.
 */
export async function exchangeCode(code: string, state: string): Promise<ExchangeResult> {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || Date.now() - p.createdAt > PENDING_TTL_MS) {
    throw new Error('Sign-in session expired or invalid — please try again');
  }

  const data = await tokenRequest({
    client_id: env.microsoftOAuth.clientId,
    client_secret: env.microsoftOAuth.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
    scope: SCOPES,
  });

  if (!data.refresh_token) {
    throw new Error('No refresh token returned — ensure offline_access scope is granted');
  }

  const claims = data.id_token ? decodeJwtPayload(data.id_token) : {};
  const email =
    (claims.preferred_username as string) ||
    (claims.email as string) ||
    (claims.upn as string) ||
    '';
  if (!email) throw new Error('Could not determine mailbox address from sign-in');

  return {
    email,
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

// --- Access-token cache: accountId -> { accessToken, expiresAt } ---
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
// Refresh a minute early so a token never expires mid-operation.
const EXPIRY_SKEW_MS = 60_000;

/**
 * Return a valid access token for the account, refreshing via the stored
 * refresh token when needed. If Microsoft rotates the refresh token, `onRotate`
 * is invoked so the caller can persist the new one.
 */
export async function getAccessToken(
  accountId: string,
  refreshToken: string,
  onRotate: (newRefreshToken: string) => void,
): Promise<string> {
  const cached = tokenCache.get(accountId);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return cached.accessToken;
  }

  const data = await tokenRequest({
    client_id: env.microsoftOAuth.clientId,
    client_secret: env.microsoftOAuth.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES,
  });

  const expiresAt = Date.now() + data.expires_in * 1000;
  tokenCache.set(accountId, { accessToken: data.access_token, expiresAt });
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    onRotate(data.refresh_token);
  }
  return data.access_token;
}

/** Drop any cached access token for an account (e.g. on delete). */
export function clearTokenCache(accountId: string): void {
  tokenCache.delete(accountId);
}

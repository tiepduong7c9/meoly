import { Router, type Request } from 'express';
import { env } from '../env.js';
import { buildAuthUrl, exchangeCode } from '../imap/oauth/microsoft.js';
import { testOAuthConnection } from '../imap/pool.js';
import { createOAuthAccount } from '../services/accounts.js';

// Outlook/Office 365 IMAP endpoint — same for personal and org mailboxes.
const OUTLOOK_HOST = 'outlook.office365.com';
const OUTLOOK_PORT = 993;

/** Resolve the OAuth redirect URI: explicit env, else derived from the request. */
function callbackUri(req: Request): string {
  if (env.microsoftOAuth.redirectUri) return env.microsoftOAuth.redirectUri;
  // Honor reverse-proxy headers so this works behind a deployed domain.
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
  return `${proto}://${host}/api/oauth/microsoft/callback`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

/** Popup page: notify the opener of the outcome, then close. */
function resultPage(ok: boolean, detail: string): string {
  const payload = JSON.stringify({ type: 'meoly:oauth', provider: 'microsoft', ok, detail });
  const heading = ok ? 'Mailbox connected' : 'Sign-in failed';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title>
<style>body{font-family:system-ui,sans-serif;padding:2rem;text-align:center;color:#333}</style></head>
<body><h3>${escapeHtml(heading)}</h3><p>${escapeHtml(detail)}</p>
<p style="color:#888">You can close this window.</p>
<script>
  try { if (window.opener) window.opener.postMessage(${payload}, '*'); } catch (e) {}
  setTimeout(function(){ window.close(); }, ${ok ? 800 : 4000});
</script></body></html>`;
}

// --- Public router: the OAuth callback (browser redirect carries no Bearer
// token; security rests on the single-use, server-issued `state`). ---
export const oauthCallbackRouter: Router = Router();

oauthCallbackRouter.get('/microsoft/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;
  res.set('Content-Type', 'text/html; charset=utf-8');

  if (error) {
    console.error('[oauth] provider returned error:', error, error_description);
    res.status(400).send(resultPage(false, error_description || error));
    return;
  }
  if (!code || !state) {
    console.error('[oauth] callback missing code/state', { hasCode: !!code, hasState: !!state });
    res.status(400).send(resultPage(false, 'Missing authorization code'));
    return;
  }

  try {
    const result = await exchangeCode(code, state);
    // Verify the token actually authenticates IMAP before persisting.
    await testOAuthConnection({
      host: OUTLOOK_HOST,
      port: OUTLOOK_PORT,
      secure: true,
      user: result.email,
      accessToken: result.accessToken,
    });
    createOAuthAccount({
      label: result.email,
      host: OUTLOOK_HOST,
      port: OUTLOOK_PORT,
      secure: true,
      username: result.email,
      refreshToken: result.refreshToken,
      provider: 'microsoft',
    });
    console.log('[oauth] connected mailbox', result.email);
    res.send(resultPage(true, `Connected ${result.email}`));
  } catch (err) {
    console.error('[oauth] callback failed:', err);
    res.status(400).send(resultPage(false, (err as Error).message));
  }
});

// --- Authed router: starts the flow. Requiring auth here is what secures the
// public callback — an attacker cannot obtain a valid `state` without a session.
export const oauthStartRouter: Router = Router();

oauthStartRouter.get('/microsoft/start', (req, res) => {
  if (!env.microsoftOAuth.enabled) {
    res.status(400).json({
      error: 'Microsoft OAuth is not configured',
      detail: 'Set MS_OAUTH_CLIENT_ID and MS_OAUTH_CLIENT_SECRET on the server.',
    });
    return;
  }
  const url = buildAuthUrl(callbackUri(req));
  res.json({ url });
});

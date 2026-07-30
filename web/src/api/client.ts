import type {
  Account,
  AiAccountSettings,
  AiBatchAction,
  AiDecision,
  AiGlobalSettings,
  AiGlobalSettingsPatch,
  AiStatus,
  AiSuggestion,
  Folder,
  MessageDetail,
  MessageSummary,
  NewAccountInput,
} from './types';

export const SESSION_KEY = 'meoly_token';

export function getToken(): string | null {
  return sessionStorage.getItem(SESSION_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(SESSION_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers, ...init });
  // Only treat a 401 as session expiry when the server explicitly says so.
  // Checking the body field avoids logging out on any future route that returns
  // 401 for a different reason (e.g. a per-resource permission check).
  if (res.status === 401) {
    let bodyError: string | undefined;
    try {
      bodyError = ((await res.clone().json()) as { error?: string }).error;
    } catch { /* non-JSON */ }
    if (bodyError === 'session_expired') {
      clearToken();
      window.dispatchEvent(new Event('meoly:unauthenticated'));
      throw new Error('Session expired — please log in again');
    }
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      message = body.detail ? `${body.error}: ${body.detail}` : body.error ?? message;
    } catch {
      /* non-JSON error */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const q = (folder: string) => `folder=${encodeURIComponent(folder)}`;

export const api = {
  authStatus: () => request<{ enabled: boolean }>('/api/auth/status'),

  login: (code: string) =>
    request<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),

  listAccounts: () => request<Account[]>('/api/accounts'),

  addAccount: (input: NewAccountInput) =>
    request<Account>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteAccount: (id: string) =>
    request<void>(`/api/accounts/${id}`, { method: 'DELETE' }),

  // Returns the Microsoft authorize URL to open in a popup; the account is
  // created server-side when Microsoft redirects to the callback.
  oauthStart: (provider: 'microsoft') =>
    request<{ url: string }>(`/api/oauth/${provider}/start`),

  syncAccount: (id: string) =>
    request<{ ok: true }>(`/api/accounts/${id}/sync`, { method: 'POST' }),

  listFolders: (accountId: string, refresh = false) =>
    request<Folder[]>(`/api/accounts/${accountId}/folders${refresh ? '?refresh=true' : ''}`),

  listMessages: (
    accountId: string,
    folder: string,
    opts: { refresh?: boolean; limit?: number; offset?: number } = {},
  ) => {
    const params = [q(folder)];
    if (opts.limit != null) params.push(`limit=${opts.limit}`);
    if (opts.offset) params.push(`offset=${opts.offset}`);
    if (opts.refresh) params.push('refresh=true');
    return request<MessageSummary[]>(`/api/accounts/${accountId}/messages?${params.join('&')}`);
  },

  getMessage: (accountId: string, folder: string, uid: number) =>
    request<MessageDetail>(`/api/accounts/${accountId}/messages/${uid}?${q(folder)}`),

  setRead: (accountId: string, folder: string, uid: number, seen: boolean) =>
    request<{ ok: true }>(`/api/accounts/${accountId}/messages/${uid}/read?${q(folder)}`, {
      method: 'POST',
      body: JSON.stringify({ seen }),
    }),

  move: (accountId: string, folder: string, uid: number, target: string) =>
    request<{ ok: true; target: string }>(
      `/api/accounts/${accountId}/messages/${uid}/move?${q(folder)}`,
      { method: 'POST', body: JSON.stringify({ target }) },
    ),

  archive: (accountId: string, folder: string, uid: number) =>
    request<{ ok: true; target: string }>(
      `/api/accounts/${accountId}/messages/${uid}/archive?${q(folder)}`,
      { method: 'POST' },
    ),

  remove: (accountId: string, folder: string, uid: number, hard = false) =>
    request<{ ok: true; trashed: boolean }>(
      `/api/accounts/${accountId}/messages/${uid}?${q(folder)}${hard ? '&hard=true' : ''}`,
      { method: 'DELETE' },
    ),

  // Bulk action over many UIDs in a single request; the backend batches the IMAP
  // side and drives it through the per-account action queue.
  bulk: (
    accountId: string,
    folder: string,
    body: {
      action: 'read' | 'unread' | 'archive' | 'move' | 'delete';
      uids: number[];
      target?: string;
      hard?: boolean;
    },
  ) =>
    request<{ ok: true; target?: string; trashed?: boolean; count: number }>(
      `/api/accounts/${accountId}/messages/bulk?${q(folder)}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // --- AI triage ---
  aiStatus: () => request<AiStatus>('/api/ai/status'),

  aiSuggestions: (status = 'pending') =>
    request<AiSuggestion[]>(`/api/ai/suggestions?status=${encodeURIComponent(status)}`),

  aiDecide: (id: string, action: AiDecision) =>
    request<{ ok: true; status: string; applied: boolean; dryRun: boolean; alreadyResolved: boolean }>(
      `/api/ai/suggestions/${id}/decision`,
      { method: 'POST', body: JSON.stringify({ action }) },
    ),

  aiDecideBatch: (ids: string[], action: AiBatchAction) =>
    request<{ ok: true; results: Array<Record<string, unknown>> }>(
      '/api/ai/suggestions/decision',
      { method: 'POST', body: JSON.stringify({ ids, action }) },
    ),

  aiRun: () =>
    request<{ ok: true }>('/api/ai/run', { method: 'POST', body: JSON.stringify({}) }),

  aiGetSettings: (accountId: string) =>
    request<AiAccountSettings>(`/api/ai/accounts/${accountId}/settings`),

  aiUpdateSettings: (accountId: string, patch: Partial<Omit<AiAccountSettings, 'accountId'>>) =>
    request<AiAccountSettings>(`/api/ai/accounts/${accountId}/settings`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  aiGetGlobalSettings: () =>
    request<AiGlobalSettings>('/api/ai/global-settings'),

  aiUpdateGlobalSettings: (patch: AiGlobalSettingsPatch) =>
    request<AiGlobalSettings>('/api/ai/global-settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
};

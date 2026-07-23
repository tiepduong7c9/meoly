import type {
  Account,
  Folder,
  MessageDetail,
  MessageSummary,
  NewAccountInput,
} from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
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
  listAccounts: () => request<Account[]>('/api/accounts'),

  addAccount: (input: NewAccountInput) =>
    request<Account>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteAccount: (id: string) =>
    request<void>(`/api/accounts/${id}`, { method: 'DELETE' }),

  syncAccount: (id: string) =>
    request<{ ok: true }>(`/api/accounts/${id}/sync`, { method: 'POST' }),

  listFolders: (accountId: string, refresh = false) =>
    request<Folder[]>(`/api/accounts/${accountId}/folders${refresh ? '?refresh=true' : ''}`),

  listMessages: (accountId: string, folder: string, refresh = false) =>
    request<MessageSummary[]>(
      `/api/accounts/${accountId}/messages?${q(folder)}${refresh ? '&refresh=true' : ''}`,
    ),

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
};

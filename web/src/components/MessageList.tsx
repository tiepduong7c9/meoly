import { useEffect, useState } from 'react';
import { AlertCircle, Paperclip, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { MessageSummary } from '../api/types';
import { useFolders, useFilteredMessages } from '../hooks';

// SQLite datetime('now') is space-separated UTC without a zone; normalize it.
function serverTimeToMs(s: string | null): number {
  if (!s) return 0;
  const ms = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? 0 : ms;
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    // Only show the year for messages outside the current year.
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

interface Props {
  accountId: string;
  folder: string;
  selectedUid: number | null;
  onSelect: (uid: number) => void;
}

export function MessageList({ accountId, folder, selectedUid, onSelect }: Props) {
  const { data, isLoading, isFetching, isError, error } = useFilteredMessages(accountId, folder);
  const { data: folders } = useFolders(accountId);
  const meta = folders?.find((f) => f.path === folder);
  const qc = useQueryClient();

  // Prefer the server's persistent sync state (survives reloads, reflects
  // background sync) over the client's in-session fetch state.
  const syncing = meta?.syncStatus === 'syncing' || isFetching;
  const lastSyncedMs = serverTimeToMs(meta?.lastSyncedAt ?? null);

  // Re-render every 20s so the "synced Xs ago" label stays current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 20_000);
    return () => clearInterval(id);
  }, []);

  const refresh = async () => {
    // Force a real IMAP sync, then refresh the cached views.
    await qc.fetchQuery({
      queryKey: ['messages', accountId, folder],
      queryFn: () => api.listMessages(accountId, folder, true),
    });
    qc.invalidateQueries({ queryKey: ['folders', accountId] });
  };

  return (
    <div className="flex h-full w-96 shrink-0 flex-col border-r border-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="truncate text-sm font-semibold">
            {folder.split('/').map((part, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-1 font-normal text-neutral-400">›</span>}
                {part}
              </span>
            ))}
          </span>
          {meta && (
            <span className="shrink-0 text-xs font-normal text-neutral-400">
              {meta.total.toLocaleString()} {meta.total === 1 ? 'message' : 'messages'}
              {meta.unseen > 0 && ` · ${meta.unseen} unread`}
            </span>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={syncing}
          className="rounded p-1.5 hover:bg-neutral-100 disabled:opacity-50"
          title="Sync now"
        >
          <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-neutral-400">Loading…</p>}
        {isError && <p className="p-4 text-sm text-red-600">{(error as Error).message}</p>}
        {data?.length === 0 && <p className="p-4 text-sm text-neutral-400">No messages.</p>}
        {data?.map((m: MessageSummary) => (
          <button
            key={m.uid}
            onClick={() => onSelect(m.uid)}
            className={`flex w-full flex-col gap-0.5 border-b border-neutral-100 px-4 py-3 text-left ${
              selectedUid === m.uid ? 'bg-neutral-100' : 'hover:bg-neutral-50'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`truncate text-sm ${m.seen ? 'text-neutral-700' : 'font-semibold text-neutral-900'}`}
              >
                {m.fromName || m.fromAddr || 'Unknown'}
              </span>
              <span className="shrink-0 text-xs text-neutral-400">{formatDate(m.date)}</span>
            </div>
            <div className="flex items-center gap-1">
              {!m.seen && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />}
              <span className={`truncate text-sm ${m.seen ? 'text-neutral-600' : 'text-neutral-900'}`}>
                {m.subject || '(no subject)'}
              </span>
              {m.hasAttachments && <Paperclip size={13} className="ml-auto shrink-0 text-neutral-400" />}
            </div>
          </button>
        ))}
      </div>

    </div>
  );
}

// Exported so App.tsx can render it in a full-width bottom bar.
export function FolderSyncStatus({
  accountId,
  folder,
}: {
  accountId: string;
  folder: string;
}) {
  const { isFetching, isError } = useFilteredMessages(accountId, folder);
  const { data: folders } = useFolders(accountId);
  const meta = folders?.find((f) => f.path === folder);
  const syncing = meta?.syncStatus === 'syncing' || isFetching;
  const lastSyncedMs = serverTimeToMs(meta?.lastSyncedAt ?? null);

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 20_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-1 items-center gap-1.5 px-4 py-1.5">
      {syncing ? (
        <>
          <RefreshCw size={11} className="animate-spin text-neutral-400" />
          <span className="text-xs text-neutral-400">Syncing…</span>
        </>
      ) : meta?.syncStatus === 'error' || isError ? (
        <>
          <AlertCircle size={11} className="text-red-500" />
          <span className="text-xs text-red-500" title={meta?.syncError ?? undefined}>
            Sync failed
          </span>
        </>
      ) : (
        <span className="text-xs text-neutral-400">
          {lastSyncedMs ? `Synced ${relativeTime(lastSyncedMs)}` : 'Not synced yet'}
        </span>
      )}
    </div>
  );
}

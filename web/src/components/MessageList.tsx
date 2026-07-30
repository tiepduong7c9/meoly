import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, AlertCircle, Mail, MailOpen, Paperclip, RefreshCw, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { MessageSummary } from '../api/types';
import { MESSAGE_PAGE_SIZE, useFolders, useFilteredMessages, useMessageMutations } from '../hooks';
import { MoveMenu } from './MoveMenu';

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
  onSelect: (uid: number | null) => void;
}

export function MessageList({ accountId, folder, selectedUid, onSelect }: Props) {
  const { data, isLoading, isFetching, isError, error, fetchNextPage, hasMore, isFetchingNextPage, refetch } =
    useFilteredMessages(accountId, folder);
  const { data: folders } = useFolders(accountId);
  const meta = folders?.find((f) => f.path === folder);
  const qc = useQueryClient();
  const {
    bulkArchive: archiveMut,
    bulkMove: moveMut,
    bulkRemove: removeMut,
    bulkSetRead: setReadMut,
  } = useMessageMutations(accountId, folder);

  // Multi-select state: UIDs the user has checked for a bulk action. Anchored on
  // the last-clicked UID so Shift-click can select a contiguous range.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  // Clear the selection outright when the account or folder changes.
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [accountId, folder]);

  // Prefer the server's persistent sync state (survives reloads, reflects
  // background sync) over the client's in-session fetch state.
  const syncing = meta?.syncStatus === 'syncing' || isFetching;

  const refresh = async () => {
    // Force a real IMAP reconcile on page 0, then revalidate every loaded page.
    await api.listMessages(accountId, folder, { refresh: true, limit: MESSAGE_PAGE_SIZE, offset: 0 });
    await refetch();
    qc.invalidateQueries({ queryKey: ['folders', accountId] });
  };

  const uids = useMemo(() => data?.map((m) => m.uid) ?? [], [data]);

  // Drop selected UIDs that have left the list (synced away, moved elsewhere),
  // so a bulk action never fires against a message no longer in this folder.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(uids);
      const next = new Set([...prev].filter((u) => live.has(u)));
      return next.size === prev.size ? prev : next;
    });
  }, [uids]);

  // Auto-load the next page when a sentinel near the list bottom scrolls into
  // view. rootMargin fetches slightly ahead so scrolling stays smooth.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, isFetchingNextPage, fetchNextPage]);

  const allSelected = uids.length > 0 && selected.size === uids.length;

  const toggle = (uid: number, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchor != null) {
        // Select the contiguous range between the anchor and this row.
        const a = uids.indexOf(anchor);
        const b = uids.indexOf(uid);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(uids[i]);
          return next;
        }
      }
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
    setAnchor(uid);
  };

  const clearSelection = () => {
    setSelected(new Set());
    setAnchor(null);
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(uids));
    setAnchor(null);
  };

  // Send the whole selection to the backend in a single bulk request; the server
  // batches the IMAP side and drives it through its per-account action queue.
  const runBulk = (fire: (uids: number[]) => void, removes: boolean) => {
    const uids = Array.from(selected);
    if (uids.length === 0) return;
    fire(uids);
    if (removes && selectedUid != null && selected.has(selectedUid)) onSelect(null);
    clearSelection();
  };

  const bulkRead = (seen: boolean) => runBulk((uids) => setReadMut.mutate({ uids, seen }), false);
  const bulkArchive = () => runBulk((uids) => archiveMut.mutate({ uids }), true);
  const bulkDelete = () => runBulk((uids) => removeMut.mutate({ uids }), true);
  const bulkMove = (target: string) => runBulk((uids) => moveMut.mutate({ uids, target }), true);

  const selecting = selected.size > 0;

  return (
    <div className="flex h-full w-96 shrink-0 flex-col border-r border-neutral-200">
      {selecting ? (
        <div className="flex items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-2 py-2">
          <button
            onClick={clearSelection}
            title="Clear selection"
            className="rounded p-1.5 text-neutral-600 hover:bg-neutral-200"
          >
            <X size={16} />
          </button>
          <span className="mr-1 text-sm font-medium text-neutral-700">{selected.size} selected</span>
          <div className="ml-auto flex items-center gap-0.5">
            <BulkButton title="Mark read" onClick={() => bulkRead(true)}>
              <MailOpen size={17} />
            </BulkButton>
            <BulkButton title="Mark unread" onClick={() => bulkRead(false)}>
              <Mail size={17} />
            </BulkButton>
            <BulkButton title="Archive" onClick={bulkArchive}>
              <Archive size={17} />
            </BulkButton>
            <BulkButton title="Delete" onClick={bulkDelete}>
              <Trash2 size={17} />
            </BulkButton>
            <MoveMenu folders={folders ?? []} currentFolder={folder} onMove={bulkMove} />
          </div>
        </div>
      ) : (
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
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-neutral-400">Loading…</p>}
        {isError && <p className="p-4 text-sm text-red-600">{(error as Error).message}</p>}
        {data?.length === 0 && <p className="p-4 text-sm text-neutral-400">No messages.</p>}
        {selecting && uids.length > 0 && (
          <button
            onClick={toggleAll}
            className="flex w-full items-center gap-2 border-b border-neutral-100 px-4 py-1.5 text-left text-xs text-neutral-500 hover:bg-neutral-50"
          >
            <input
              type="checkbox"
              readOnly
              tabIndex={-1}
              checked={allSelected}
              className="pointer-events-none h-3.5 w-3.5 accent-blue-600"
            />
            {allSelected ? 'Deselect all' : `Select all ${uids.length}`}
          </button>
        )}
        {data?.map((m: MessageSummary) => {
          const isChecked = selected.has(m.uid);
          return (
            <div
              key={m.uid}
              className={`group flex items-start border-b border-neutral-100 ${
                isChecked ? 'bg-blue-50' : selectedUid === m.uid ? 'bg-neutral-100' : 'hover:bg-neutral-50'
              }`}
            >
              <div
                role="checkbox"
                aria-checked={isChecked}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(m.uid, e.shiftKey);
                }}
                className={`flex cursor-pointer items-center self-stretch pl-4 pr-3 ${
                  selecting || isChecked ? '' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                <input
                  type="checkbox"
                  readOnly
                  tabIndex={-1}
                  checked={isChecked}
                  className="pointer-events-none h-4 w-4 accent-blue-600"
                />
              </div>
              <button
                onClick={() => onSelect(m.uid)}
                className="flex min-w-0 flex-1 flex-col gap-0.5 py-3 pr-4 pl-0 text-left"
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
            </div>
          );
        })}
        {/* Sentinel + status for infinite scroll. */}
        {hasMore && <div ref={sentinelRef} className="h-px" />}
        {isFetchingNextPage && (
          <p className="p-3 text-center text-xs text-neutral-400">Loading more…</p>
        )}
      </div>

    </div>
  );
}

function BulkButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded-md p-2 text-neutral-700 hover:bg-neutral-200"
    >
      {children}
    </button>
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

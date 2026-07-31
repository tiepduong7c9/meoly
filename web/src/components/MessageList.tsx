import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, AlertCircle, FolderInput, Mail, MailOpen, Paperclip, RefreshCw, Trash2, X, MailCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Folder, MessageSummary } from '../api/types';
import { MESSAGE_PAGE_SIZE, useFolders, useFilteredMessages, useMessageMutations } from '../hooks';
import { folderIcon, sortFolders } from '../lib/folders';
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
  // Reports the list's current ordered UIDs up to MailPane, which uses them for
  // keyboard navigation and for choosing the next message after an action.
  onUidsChange?: (uids: number[]) => void;
  // Lifted to App so MessageView and FolderSyncStatus read the same list (cache
  // key) the user is viewing — see messagesKey in hooks.ts.
  showUnreadOnly: boolean;
  onToggleUnread: () => void;
}

export function MessageList({
  accountId,
  folder,
  selectedUid,
  onSelect,
  onUidsChange,
  showUnreadOnly,
  onToggleUnread,
}: Props) {
  const { data, isLoading, isFetching, isError, error, fetchNextPage, hasMore, isFetchingNextPage, refetch } =
    useFilteredMessages(accountId, folder, showUnreadOnly);
  const { data: folders } = useFolders(accountId);
  const meta = folders?.find((f) => f.path === folder);
  const qc = useQueryClient();
  const {
    archive: archiveOne,
    remove: removeOne,
    move: moveOne,
    bulkArchive: archiveMut,
    bulkMove: moveMut,
    bulkRemove: removeMut,
    bulkSetRead: setReadMut,
  } = useMessageMutations(accountId, folder, showUnreadOnly);

  // Multi-select state: UIDs the user has checked for a bulk action. Anchored on
  // the last-clicked UID so Shift-click can select a contiguous range.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  // UID of the row whose hover "Move" menu is open. Kept here (not inside the
  // row) so the row's action bar stays visible while its menu is open, even
  // after the pointer leaves the row to reach the dropdown.
  const [moveMenuUid, setMoveMenuUid] = useState<number | null>(null);

  // Clear the selection when the account or folder changes. (The unread filter is
  // reset by App, which owns that state.)
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

  // When showing unread only, eagerly load all remaining pages so "Select all"
  // covers the whole unread set, not just what's scrolled into view. The unread
  // list is filtered server-side (bounded by the folder's unread count), so this
  // pulls only the few unread pages rather than the entire folder.
  useEffect(() => {
    if (showUnreadOnly && hasMore && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [showUnreadOnly, hasMore, isFetchingNextPage, fetchNextPage]);

  // The server already filters to unread when showUnreadOnly; the client-side
  // filter is a defensive guard against a just-read row lingering for one render.
  const displayData = useMemo(
    () => (showUnreadOnly ? (data ?? []).filter((m) => !m.seen) : data),
    [data, showUnreadOnly],
  );

  const uids = useMemo(() => displayData?.map((m) => m.uid) ?? [], [displayData]);

  // Report the ordered UIDs up to MailPane for keyboard nav. Guard on a stable
  // key so the polling re-renders (new array identity, same contents) don't churn
  // the parent's state.
  const reportedUids = useRef<string>('');
  useEffect(() => {
    const key = uids.join(',');
    if (key === reportedUids.current) return;
    reportedUids.current = key;
    onUidsChange?.(uids);
  }, [uids, onUidsChange]);

  // Keep the keyboard-selected row visible as the user arrows past the viewport.
  const selectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedUid]);

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

  // Per-row quick actions (revealed on hover). These use the single-message
  // mutations; each drops the row, so clear the open message if it was the one
  // acted on. stopPropagation (in the buttons) keeps the click off the row.
  const quickArchive = (m: MessageSummary) => {
    archiveOne.mutate({ uid: m.uid });
    if (selectedUid === m.uid) onSelect(null);
  };
  const quickDelete = (m: MessageSummary) => {
    removeOne.mutate({ uid: m.uid });
    if (selectedUid === m.uid) onSelect(null);
  };
  const quickMove = (m: MessageSummary, target: string) => {
    moveOne.mutate({ uid: m.uid, target });
    if (selectedUid === m.uid) onSelect(null);
  };

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
          <div className="flex items-center gap-0.5">
            <button
              onClick={onToggleUnread}
              title={showUnreadOnly ? 'Show all messages' : 'Show unread only'}
              className={`rounded p-1.5 ${showUnreadOnly ? 'bg-blue-100 text-blue-600 hover:bg-blue-200' : 'hover:bg-neutral-100 text-neutral-500'}`}
            >
              <MailCheck size={16} />
            </button>
            <button
              onClick={refresh}
              disabled={syncing}
              className="rounded p-1.5 hover:bg-neutral-100 disabled:opacity-50"
              title="Sync now"
            >
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-neutral-400">Loading…</p>}
        {isError && <p className="p-4 text-sm text-red-600">{(error as Error).message}</p>}
        {displayData?.length === 0 && !isFetchingNextPage && (
          <p className="p-4 text-sm text-neutral-400">
            {showUnreadOnly ? 'No unread messages.' : 'No messages.'}
          </p>
        )}
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
        {displayData?.map((m: MessageSummary) => {
          const isChecked = selected.has(m.uid);
          // The gradient fade behind the hover actions matches the row's own
          // background so the buttons read as sitting on the row, not floating.
          // The `via` stop keeps the button area fully opaque (hiding the
          // subject text beneath it); only the narrow left strip fades out.
          const fadeFrom = isChecked
            ? 'from-blue-50 via-blue-50'
            : selectedUid === m.uid
              ? 'from-neutral-100 via-neutral-100'
              : 'from-neutral-50 via-neutral-50';
          return (
            <div
              key={m.uid}
              ref={selectedUid === m.uid ? selectedRef : undefined}
              className={`group relative flex items-start border-b border-neutral-100 ${
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
                className="flex min-w-0 flex-1 flex-col gap-0.5 py-3 pr-4 pl-0 text-left focus:outline-none"
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
              {/* Quick actions, revealed on row hover. Hidden while a bulk
                  selection is active so the two workflows don't overlap. Stays
                  pinned visible while this row's Move menu is open. */}
              {!selecting && (
                <div
                  className={`absolute inset-y-0 right-0 flex items-center gap-1 bg-gradient-to-l via-80% to-transparent pl-10 pr-2 transition-opacity ${fadeFrom} ${
                    moveMenuUid === m.uid
                      ? 'opacity-100'
                      : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
                  }`}
                >
                  <RowMoveMenu
                    folders={folders ?? []}
                    currentFolder={folder}
                    open={moveMenuUid === m.uid}
                    onOpenChange={(o) => setMoveMenuUid(o ? m.uid : null)}
                    onMove={(target) => quickMove(m, target)}
                  />
                  <QuickAction title="Archive" onClick={() => quickArchive(m)}>
                    <Archive size={16} />
                  </QuickAction>
                  <QuickAction title="Delete" danger onClick={() => quickDelete(m)}>
                    <Trash2 size={16} />
                  </QuickAction>
                </div>
              )}
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

// Shared styling for the hover-revealed row action buttons. A white pill with a
// border and shadow so the icons read as raised controls over the row's
// gradient fade rather than blending into it.
const QUICK_ACTION_BASE =
  'rounded-md border border-neutral-200 bg-white p-1.5 text-neutral-700 shadow-sm transition-colors';

// A single hover-revealed quick action on a message row. stopPropagation keeps
// the click from bubbling to the row's open/select handlers. `danger` gives
// destructive actions (Delete) a red hover state.
function QuickAction({
  children,
  title,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`${QUICK_ACTION_BASE} ${
        danger
          ? 'hover:border-red-300 hover:bg-red-600 hover:text-white'
          : 'hover:border-neutral-800 hover:bg-neutral-800 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

// Compact, icon-only "Move to folder" menu for a message row's hover actions.
// The dropdown renders in a portal with fixed positioning so it isn't clipped
// by the message list's scroll container. `open` is controlled by the parent so
// the row's action bar can stay visible while the menu is open.
function RowMoveMenu({
  folders,
  currentFolder,
  open,
  onOpenChange,
  onMove,
}: {
  folders: Folder[];
  currentFolder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (target: string) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    // The menu is fixed-positioned from a one-time rect, so close it on scroll or
    // resize rather than let it float away from its button.
    const close = () => onOpenChange(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, onOpenChange]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Right-align the 224px (w-56) menu under the button, clamped to the
      // viewport; flip above the button when it would overflow the bottom.
      const MENU_W = 224;
      const MENU_H = 320; // max-h-80
      const left = Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8));
      const top =
        r.bottom + 4 + MENU_H > window.innerHeight
          ? Math.max(8, r.top - MENU_H - 4)
          : r.bottom + 4;
      setPos({ top, left });
    }
    onOpenChange(!open);
  };

  const targets = sortFolders(folders.filter((f) => f.path !== currentFolder));

  return (
    <>
      <button
        ref={btnRef}
        title="Move to folder"
        onClick={toggle}
        className={`${QUICK_ACTION_BASE} ${
          open
            ? 'border-neutral-800 bg-neutral-800 text-white'
            : 'hover:border-neutral-800 hover:bg-neutral-800 hover:text-white'
        }`}
      >
        <FolderInput size={16} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-30 max-h-80 w-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-lg"
          >
            {targets.map((f) => {
              const Icon = folderIcon(f);
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(f.path);
                    onOpenChange(false);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100"
                >
                  <Icon size={15} className="shrink-0 text-neutral-500" />
                  <span className="flex-1 truncate">{f.name}</span>
                  {f.unseen > 0 && (
                    <span className="rounded-full bg-neutral-200 px-1.5 text-xs text-neutral-600">
                      {f.unseen}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

// Exported so App.tsx can render it in a full-width bottom bar.
export function FolderSyncStatus({
  accountId,
  folder,
  showUnreadOnly,
}: {
  accountId: string;
  folder: string;
  showUnreadOnly: boolean;
}) {
  // Observe the same list (full vs unread) the user is viewing, so the fetching
  // indicator reflects that view and no extra query is kept alive.
  const { isFetching, isError } = useFilteredMessages(accountId, folder, showUnreadOnly);
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

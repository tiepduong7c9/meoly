import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Mail, MailOpen, RefreshCw, AlertCircle, Bot, ChevronRight } from 'lucide-react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import type { Account, Folder } from '../api/types';
import { useAiStatus, useFolders, useMarkFolderRead, useSyncAccount } from '../hooks';
import { folderIcon, sortFolders } from '../lib/folders';

interface Props {
  accounts: Account[];
  selectedAccount: string | null;
  selectedFolder: string | null;
  view: 'mail' | 'review';
  onSelectAccount: (id: string) => void;
  onSelectFolder: (path: string) => void;
  onSelectReview: () => void;
  onAddAccount: () => void;
}

export function AccountSidebar({
  accounts,
  selectedAccount,
  selectedFolder,
  view,
  onSelectAccount,
  onSelectFolder,
  onSelectReview,
  onAddAccount,
}: Props) {
  const aiStatus = useAiStatus();
  const pending = aiStatus.data?.counts?.pending ?? 0;
  const aiEnabled = aiStatus.data?.enabled ?? false;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <Mail size={18} /> Meoly
        </div>
        <button
          onClick={onAddAccount}
          className="rounded-md p-1.5 hover:bg-neutral-200"
          title="Add mailbox"
        >
          <Plus size={18} />
        </button>
      </div>

      {(aiEnabled || pending > 0) && (
        <div className="px-2 pb-1">
          <button
            onClick={onSelectReview}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium ${
              view === 'review' ? 'bg-neutral-800 text-white' : 'hover:bg-neutral-100'
            }`}
          >
            <Bot size={16} className="shrink-0" />
            <span className="flex-1">AI Review</span>
            {pending > 0 && (
              <span
                className={`rounded-full px-1.5 text-xs ${
                  view === 'review' ? 'bg-white/20' : 'bg-blue-100 text-blue-700'
                }`}
              >
                {pending}
              </span>
            )}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {accounts.length === 0 && (
          <p className="px-2 py-4 text-sm text-neutral-500">
            No mailboxes yet. Click + to add one.
          </p>
        )}
        {accounts.map((account) => (
          <AccountBlock
            key={account.id}
            account={account}
            expanded={selectedAccount === account.id}
            selectedFolder={selectedAccount === account.id ? selectedFolder : null}
            onSelectAccount={() => onSelectAccount(account.id)}
            onSelectFolder={onSelectFolder}
          />
        ))}
      </div>

    </aside>
  );
}


function AccountBlock({
  account,
  expanded,
  selectedFolder,
  onSelectAccount,
  onSelectFolder,
}: {
  account: Account;
  expanded: boolean;
  selectedFolder: string | null;
  onSelectAccount: () => void;
  onSelectFolder: (path: string) => void;
}) {
  const syncAccount = useSyncAccount();
  const qc = useQueryClient();
  // Fetch folders even when collapsed so the total unread badge stays live.
  const folders = useFolders(account.id);
  const markRead = useMarkFolderRead(account.id);

  // Right-click context menu, held at the block level so only one folder's menu
  // is ever open (right-clicking another folder just repositions it).
  const [ctxMenu, setCtxMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const ctxFolder = ctxMenu ? folders.data?.find((f) => f.path === ctxMenu.path) : undefined;

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setCtxMenu(null);
    // A left-click, scroll, or resize dismisses it. (Right-click fires no click
    // event, so opening another folder's menu goes through onOpenMenu instead.)
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);
  // Account is "syncing" while any of its folders is being synced in the
  // background, or while its folder list is being (re)fetched.
  const anyFolderSyncing = folders.data?.some((f) => f.syncStatus === 'syncing') ?? false;
  const listFetching = useIsFetching({ queryKey: ['folders', account.id] }) > 0;
  const syncing = anyFolderSyncing || listFetching || syncAccount.isPending;
  // Total unread across all of this account's folders — shown when collapsed.
  const totalUnread = folders.data?.reduce((sum, f) => sum + f.unseen, 0) ?? 0;

  const syncNow = (e: React.MouseEvent) => {
    e.stopPropagation();
    syncAccount.mutate(account.id, {
      onSuccess: () => {
        // Poll a couple times so the freshly-triggered pass shows quickly.
        setTimeout(() => qc.invalidateQueries({ queryKey: ['folders', account.id] }), 800);
      },
    });
  };

  return (
    <div className="mb-2">
      <button
        onClick={onSelectAccount}
        className={`group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm font-semibold tracking-wide ${
          expanded ? 'bg-neutral-800 text-white' : 'hover:bg-neutral-100'
        }`}
      >
        <span className="flex items-center gap-1.5 truncate">
          <ChevronRight
            size={13}
            className={`shrink-0 transition-transform duration-150 ${expanded ? 'rotate-90 text-white/60' : 'text-neutral-400'}`}
          />
          <span className="truncate">{account.label}</span>
        </span>
        <span className="flex items-center gap-1">
          {expanded ? (
            // Expanded: allow a manual sync (spinner while a pass is running).
            syncing ? (
              <RefreshCw size={13} className="animate-spin text-white/60" aria-label="Syncing" />
            ) : (
              <RefreshCw
                size={13}
                className="text-white/60 hover:text-white"
                onClick={syncNow}
                aria-label="Sync now"
              />
            )
          ) : syncing ? (
            <RefreshCw size={13} className="animate-spin text-neutral-400" aria-label="Syncing" />
          ) : (
            // Collapsed: surface the total unread count instead of controls.
            totalUnread > 0 && (
              <span className="rounded-full bg-neutral-200 px-1.5 text-xs text-neutral-700">
                {totalUnread}
              </span>
            )
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 space-y-0.5">
          {folders.isLoading && <p className="px-3 py-1 text-xs text-neutral-400">Loading…</p>}
          {folders.data &&
            sortFolders(folders.data).map((f) => (
            <FolderRow
              key={f.path}
              accountId={account.id}
              folder={f}
              active={selectedFolder === f.path}
              onSelect={() => onSelectFolder(f.path)}
              onOpenMenu={(x, y) => setCtxMenu({ path: f.path, x, y })}
            />
          ))}
        </div>
      )}

      {ctxMenu &&
        ctxFolder &&
        createPortal(
          <div
            // Clamp to the viewport so a folder near an edge doesn't open the menu
            // off-screen. Width matches w-52 (208px); height is a single row.
            style={{
              top: Math.min(ctxMenu.y, window.innerHeight - 52),
              left: Math.min(ctxMenu.x, window.innerWidth - 216),
            }}
            className="fixed z-30 w-52 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              disabled={ctxFolder.unseen === 0}
              onClick={() => {
                markRead.mutate(ctxFolder.path);
                setCtxMenu(null);
              }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <MailOpen size={15} className="shrink-0 text-neutral-500" />
              <span className="flex-1">Mark all as read</span>
              {ctxFolder.unseen > 0 && (
                <span className="text-xs text-neutral-400">{ctxFolder.unseen}</span>
              )}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

function FolderRow({
  accountId,
  folder,
  active,
  onSelect,
  onOpenMenu,
}: {
  accountId: string;
  folder: Folder;
  active: boolean;
  onSelect: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const Icon = folderIcon(folder);
  // Syncing = server reports background sync in progress, or the client is
  // actively (re)fetching this folder's messages.
  const clientFetching = useIsFetching({ queryKey: ['messages', accountId, folder.path] }) > 0;
  const syncing = folder.syncStatus === 'syncing' || clientFetching;

  return (
    <button
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenMenu(e.clientX, e.clientY);
      }}
      title={folder.syncError ?? undefined}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm ${
        active ? 'bg-neutral-200 text-neutral-900' : 'hover:bg-neutral-100'
      }`}
    >
      <Icon size={15} className="shrink-0" />
      <span className="flex-1 truncate">{folder.name}</span>
      {syncing ? (
        <RefreshCw
          size={13}
          className={`shrink-0 animate-spin text-neutral-400`}
          aria-label="Syncing"
        />
      ) : folder.syncStatus === 'error' ? (
        <AlertCircle size={13} className="shrink-0 text-red-500" aria-label="Sync error" />
      ) : (
        folder.unseen > 0 && (
          <span
            className={`rounded-full px-1.5 text-xs ${
              active ? 'bg-neutral-400/30 text-neutral-700' : 'bg-neutral-200 text-neutral-700'
            }`}
          >
            {folder.unseen}
          </span>
        )
      )}
    </button>
  );
}

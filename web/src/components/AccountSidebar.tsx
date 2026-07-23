import { Plus, Mail, Trash, RefreshCw, AlertCircle } from 'lucide-react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import type { Account, Folder } from '../api/types';
import { useDeleteAccount, useFolders, useSyncAccount } from '../hooks';
import { folderIcon, sortFolders } from '../lib/folders';

interface Props {
  accounts: Account[];
  selectedAccount: string | null;
  selectedFolder: string | null;
  onSelectAccount: (id: string) => void;
  onSelectFolder: (path: string) => void;
  onAddAccount: () => void;
}

export function AccountSidebar({
  accounts,
  selectedAccount,
  selectedFolder,
  onSelectAccount,
  onSelectFolder,
  onAddAccount,
}: Props) {
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
  const deleteAccount = useDeleteAccount();
  const syncAccount = useSyncAccount();
  const qc = useQueryClient();
  const folders = useFolders(expanded ? account.id : null);
  // Account is "syncing" while any of its folders is being synced in the
  // background, or while its folder list is being (re)fetched.
  const anyFolderSyncing = folders.data?.some((f) => f.syncStatus === 'syncing') ?? false;
  const listFetching = useIsFetching({ queryKey: ['folders', account.id] }) > 0;
  const syncing = anyFolderSyncing || listFetching || syncAccount.isPending;

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
        className={`group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm font-medium ${
          expanded ? 'bg-neutral-200' : 'hover:bg-neutral-100'
        }`}
      >
        <span className="truncate">{account.label}</span>
        <span className="flex items-center gap-1">
          {syncing ? (
            <RefreshCw size={13} className="animate-spin text-neutral-400" aria-label="Syncing" />
          ) : (
            <RefreshCw
              size={13}
              className="hidden text-neutral-400 hover:text-neutral-700 group-hover:block"
              onClick={syncNow}
              aria-label="Sync now"
            />
          )}
          <Trash
            size={15}
            className="hidden text-neutral-400 hover:text-red-600 group-hover:block"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Remove ${account.label}? Cached mail will be deleted.`)) {
                deleteAccount.mutate(account.id);
              }
            }}
          />
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderRow({
  accountId,
  folder,
  active,
  onSelect,
}: {
  accountId: string;
  folder: Folder;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = folderIcon(folder);
  // Syncing = server reports background sync in progress, or the client is
  // actively (re)fetching this folder's messages.
  const clientFetching = useIsFetching({ queryKey: ['messages', accountId, folder.path] }) > 0;
  const syncing = folder.syncStatus === 'syncing' || clientFetching;

  return (
    <button
      onClick={onSelect}
      title={folder.syncError ?? undefined}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm ${
        active ? 'bg-neutral-800 text-white' : 'hover:bg-neutral-100'
      }`}
    >
      <Icon size={15} className="shrink-0" />
      <span className="flex-1 truncate">{folder.name}</span>
      {syncing ? (
        <RefreshCw
          size={13}
          className={`shrink-0 animate-spin ${active ? 'text-white/70' : 'text-neutral-400'}`}
          aria-label="Syncing"
        />
      ) : folder.syncStatus === 'error' ? (
        <AlertCircle size={13} className="shrink-0 text-red-500" aria-label="Sync error" />
      ) : (
        folder.unseen > 0 && (
          <span
            className={`rounded-full px-1.5 text-xs ${
              active ? 'bg-white/20' : 'bg-neutral-200 text-neutral-700'
            }`}
          >
            {folder.unseen}
          </span>
        )
      )}
    </button>
  );
}

import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { AccountSidebar } from './components/AccountSidebar';
import { MessageList } from './components/MessageList';
import { MessageView } from './components/MessageView';
import { AddAccountDialog } from './components/AddAccountDialog';
import { useAccounts, useFolders } from './hooks';

export function App() {
  const { data: accounts = [], isLoading } = useAccounts();
  const [showAdd, setShowAdd] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [uid, setUid] = useState<number | null>(null);

  const folders = useFolders(accountId);

  // Auto-select the first account once loaded.
  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  // Default to the Inbox when folders arrive and none is selected.
  useEffect(() => {
    if (accountId && !folder && folders.data && folders.data.length > 0) {
      const inbox =
        folders.data.find((f) => f.specialUse === '\\Inbox') ??
        folders.data.find((f) => f.path.toLowerCase() === 'inbox') ??
        folders.data[0];
      setFolder(inbox.path);
    }
  }, [accountId, folder, folders.data]);

  const selectAccount = (id: string) => {
    setAccountId(id);
    setFolder(null);
    setUid(null);
  };
  const selectFolder = (path: string) => {
    setFolder(path);
    setUid(null);
  };

  return (
    <div className="flex h-full w-full text-neutral-900">
      <AccountSidebar
        accounts={accounts}
        selectedAccount={accountId}
        selectedFolder={folder}
        onSelectAccount={selectAccount}
        onSelectFolder={selectFolder}
        onAddAccount={() => setShowAdd(true)}
      />

      {accountId && folder ? (
        <MessageList
          accountId={accountId}
          folder={folder}
          selectedUid={uid}
          onSelect={setUid}
        />
      ) : (
        <EmptyState isLoading={isLoading} hasAccounts={accounts.length > 0} />
      )}

      {accountId && folder && uid != null && (
        <MessageView
          accountId={accountId}
          folder={folder}
          uid={uid}
          folders={folders.data ?? []}
          onClose={() => setUid(null)}
        />
      )}
      {accountId && folder && uid == null && (
        <div className="flex flex-1 items-center justify-center text-neutral-400">
          Select a message to read
        </div>
      )}

      {showAdd && <AddAccountDialog onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function EmptyState({ isLoading, hasAccounts }: { isLoading: boolean; hasAccounts: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-400">
      <Mail size={48} strokeWidth={1.2} />
      <p>
        {isLoading
          ? 'Loading…'
          : hasAccounts
            ? 'Select a folder to view mail'
            : 'Add a mailbox to get started'}
      </p>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { AccountSidebar } from './components/AccountSidebar';
import { MessageList } from './components/MessageList';
import { MessageView } from './components/MessageView';
import { AddAccountDialog } from './components/AddAccountDialog';
import { ReviewPanel } from './components/ReviewPanel';
import { LoginPage } from './LoginPage';
import { useAccounts, useFolders } from './hooks';
import { api, getToken, clearToken, SESSION_KEY } from './api/client';

type View = 'mail' | 'review';

function useAuthState() {
  const [authed, setAuthed] = useState(() => !!getToken());

  useEffect(() => {
    const onUnauthenticated = () => setAuthed(false);
    window.addEventListener('meoly:unauthenticated', onUnauthenticated);
    // Also watch sessionStorage so other tabs can trigger logout.
    const onStorage = (e: StorageEvent) => {
      if (e.key === SESSION_KEY && !e.newValue) setAuthed(false);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('meoly:unauthenticated', onUnauthenticated);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const logout = () => {
    clearToken();
    setAuthed(false);
    api.logout().catch(() => {});
  };

  return { authed, login: () => setAuthed(true), logout };
}

export function App() {
  const { authed, login, logout } = useAuthState();
  if (!authed) return <LoginPage onLogin={login} />;
  return <AuthedApp onLogout={logout} />;
}

function AuthedApp({ onLogout: _onLogout }: { onLogout: () => void }) {
  const { data: accounts = [], isLoading } = useAccounts();
  const [showAdd, setShowAdd] = useState(false);
  const [view, setView] = useState<View>('mail');
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
        view={view}
        onSelectAccount={(id) => {
          setView('mail');
          selectAccount(id);
        }}
        onSelectFolder={(path) => {
          setView('mail');
          selectFolder(path);
        }}
        onSelectReview={() => setView('review')}
        onAddAccount={() => setShowAdd(true)}
      />

      {view === 'review' ? (
        <ReviewPanel accounts={accounts} />
      ) : accountId && folder ? (
        <>
          <MessageList
            accountId={accountId}
            folder={folder}
            selectedUid={uid}
            onSelect={setUid}
          />
          {uid != null ? (
            <MessageView
              accountId={accountId}
              folder={folder}
              uid={uid}
              folders={folders.data ?? []}
              onClose={() => setUid(null)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-neutral-400">
              Select a message to read
            </div>
          )}
        </>
      ) : (
        <EmptyState isLoading={isLoading} hasAccounts={accounts.length > 0} />
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

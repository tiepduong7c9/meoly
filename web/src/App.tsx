import { useEffect, useState } from 'react';
import { Mail, LogOut } from 'lucide-react';
import { AccountSidebar } from './components/AccountSidebar';
import { MessageList, FolderSyncStatus } from './components/MessageList';
import { MessageView } from './components/MessageView';
import { AddAccountDialog } from './components/AddAccountDialog';
import { ReviewPanel } from './components/ReviewPanel';
import { LoginPage } from './LoginPage';
import { useAccounts, useFolders } from './hooks';
import { api, getToken, clearToken, SESSION_KEY } from './api/client';

type View = 'mail' | 'review';

function useAuthState() {
  const [authed, setAuthed] = useState(() => !!getToken());
  // null = still checking whether the server requires TOTP auth.
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);

  useEffect(() => {
    // When TOTP auth is disabled server-side, skip the login screen entirely.
    api
      .authStatus()
      .then((s) => {
        setAuthRequired(s.enabled);
        if (!s.enabled) setAuthed(true);
      })
      .catch(() => setAuthRequired(true)); // on error, be safe and require auth
  }, []);

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
    if (!authRequired) return; // nothing to log out of when auth is disabled
    clearToken();
    setAuthed(false);
    api.logout().catch(() => {});
  };

  return { authed, ready: authRequired !== null, login: () => setAuthed(true), logout };
}

export function App() {
  const { authed, ready, login, logout } = useAuthState();
  if (!ready) return null; // brief: waiting on auth-status check
  if (!authed) return <LoginPage onLogin={login} />;
  return <AuthedApp onLogout={logout} />;
}

function AuthedApp({ onLogout }: { onLogout: () => void }) {
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
    <div className="flex h-full w-full flex-col text-neutral-900">
      <div className="flex min-h-0 flex-1">
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

      <div className="flex shrink-0 items-center border-t border-neutral-200 bg-neutral-50">
        {/* Left slot — matches sidebar width */}
        <div className="flex w-64 shrink-0 items-center px-3 py-1.5">
          {onLogout && (
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-700"
            >
              <LogOut size={13} />
              Sign out
            </button>
          )}
        </div>
        {/* Right slot — aligns with message list column */}
        {accountId && folder && <FolderSyncStatus accountId={accountId} folder={folder} />}
      </div>
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mail, LogOut, Settings } from 'lucide-react';
import { AccountSidebar } from './components/AccountSidebar';
import { MessageList, FolderSyncStatus } from './components/MessageList';
import { MessageView } from './components/MessageView';
import { AddAccountDialog } from './components/AddAccountDialog';
import { AccountSettingsDialog } from './components/AccountSettingsDialog';
import { ReviewPanel } from './components/ReviewPanel';
import { LoginPage } from './LoginPage';
import { useAccounts, useFolders, useMessageMutations } from './hooks';
import type { Folder } from './api/types';
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
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState<View>('mail');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [uid, setUid] = useState<number | null>(null);
  // Owned here so the message list, the open message, and the sync-status bar all
  // read the same list (cache key) — see messagesKey in hooks.ts.
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

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
    setShowUnreadOnly(false);
  };
  const selectFolder = (path: string) => {
    setFolder(path);
    setUid(null);
    setShowUnreadOnly(false);
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
        <MailPane
          accountId={accountId}
          folder={folder}
          uid={uid}
          onSelect={setUid}
          folders={folders.data ?? []}
          showUnreadOnly={showUnreadOnly}
          onToggleUnread={() => setShowUnreadOnly((v) => !v)}
          // Suppress list shortcuts while a modal dialog is open over the pane.
          shortcutsDisabled={showAdd || showSettings}
        />
      ) : (
        <EmptyState isLoading={isLoading} hasAccounts={accounts.length > 0} />
      )}

      {showAdd && <AddAccountDialog onClose={() => setShowAdd(false)} />}
      {showSettings && (
        <AccountSettingsDialog accounts={accounts} onClose={() => setShowSettings(false)} />
      )}
      </div>

      <div className="flex shrink-0 items-center border-t border-neutral-200 bg-neutral-50">
        {/* Left slot — matches sidebar width: Sign out left, Settings right */}
        <div className="flex w-64 shrink-0 items-center justify-between px-3 py-1.5">
          {onLogout ? (
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-700"
            >
              <LogOut size={13} />
              Sign out
            </button>
          ) : (
            <span />
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-700"
          >
            <Settings size={13} />
            Settings
          </button>
        </div>
        {/* Right area — aligns with the message list column */}
        {accountId && folder && (
          <FolderSyncStatus accountId={accountId} folder={folder} showUnreadOnly={showUnreadOnly} />
        )}
      </div>
    </div>
  );
}

// True when a keystroke is aimed at a form field (dialog inputs, etc.) or when a
// modifier is held — don't hijack those for list shortcuts.
function isTypingTarget(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  );
}

// Owns the message list + reader for one folder, plus the keyboard shortcuts that
// drive them. Extracted from App so `accountId`/`folder` are non-null here, which
// lets us call useMessageMutations unconditionally.
function MailPane({
  accountId,
  folder,
  uid,
  onSelect,
  folders,
  showUnreadOnly,
  onToggleUnread,
  shortcutsDisabled,
}: {
  accountId: string;
  folder: string;
  uid: number | null;
  onSelect: (uid: number | null) => void;
  folders: Folder[];
  showUnreadOnly: boolean;
  onToggleUnread: () => void;
  shortcutsDisabled: boolean;
}) {
  // The list's current, ordered UIDs (reported up by MessageList) — the basis for
  // arrow navigation and for picking the neighbour to open after an action.
  const [orderedUids, setOrderedUids] = useState<number[]>([]);
  const { remove, archive } = useMessageMutations(accountId, folder, showUnreadOnly);
  const removeMutate = remove.mutate;
  const archiveMutate = archive.mutate;

  // The last list index the selection resolved to. Opening a message in the
  // unread-only view marks it read, which drops it from the list — so by the next
  // keypress `uid` is gone from orderedUids. This remembers where it sat so we can
  // resume from the row that slid into its slot instead of jumping to the top.
  const lastIndex = useRef(0);
  useEffect(() => {
    if (uid == null) return;
    const i = orderedUids.indexOf(uid);
    if (i !== -1) lastIndex.current = i;
  }, [uid, orderedUids]);

  // Move the selection one row up/down, clamping at the ends (no wrap). With
  // nothing open yet, an arrow opens the first (or last) message.
  const selectRelative = useCallback(
    (dir: 1 | -1) => {
      if (orderedUids.length === 0) return;
      if (uid == null) {
        onSelect(orderedUids[dir === 1 ? 0 : orderedUids.length - 1]);
        return;
      }
      const i = orderedUids.indexOf(uid);
      if (i !== -1) {
        const next = orderedUids[i + dir];
        if (next != null) onSelect(next);
        return;
      }
      // Selection left the list (e.g. auto-marked read and filtered out of the
      // unread view). Resume relative to where it sat: for a downward move the
      // row now at that index is the successor; for upward, the row before it.
      const target = orderedUids[dir === 1 ? lastIndex.current : lastIndex.current - 1];
      if (target != null) onSelect(target);
    },
    [orderedUids, uid, onSelect],
  );

  // After the open message leaves the list (archive/delete/move), open the next
  // one — or the previous if it was last — so triage keeps flowing. Usually runs
  // while the removed UID is still in orderedUids (the optimistic drop re-renders
  // after this); if it's already gone (unread view), resume from its last index.
  const advance = useCallback(() => {
    if (uid == null) return;
    const i = orderedUids.indexOf(uid);
    if (i !== -1) {
      onSelect(orderedUids[i + 1] ?? orderedUids[i - 1] ?? null);
      return;
    }
    onSelect(orderedUids[lastIndex.current] ?? orderedUids[lastIndex.current - 1] ?? null);
  }, [orderedUids, uid, onSelect]);

  useEffect(() => {
    if (shortcutsDisabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          selectRelative(1);
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          selectRelative(-1);
          break;
        case 'Delete':
        case 'Backspace':
          // Prevent the browser's Backspace-as-back even when nothing is open.
          e.preventDefault();
          if (uid != null) {
            removeMutate({ uid });
            advance();
          }
          break;
        case 'e':
          if (uid != null) {
            e.preventDefault();
            archiveMutate({ uid });
            advance();
          }
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcutsDisabled, selectRelative, advance, uid, removeMutate, archiveMutate]);

  return (
    <>
      <MessageList
        accountId={accountId}
        folder={folder}
        selectedUid={uid}
        onSelect={onSelect}
        onUidsChange={setOrderedUids}
        showUnreadOnly={showUnreadOnly}
        onToggleUnread={onToggleUnread}
      />
      {uid != null ? (
        <MessageView
          accountId={accountId}
          folder={folder}
          uid={uid}
          folders={folders}
          onClose={advance}
          showUnreadOnly={showUnreadOnly}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-neutral-400">
          Select a message to read
        </div>
      )}
    </>
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

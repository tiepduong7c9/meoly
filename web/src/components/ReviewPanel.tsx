import { useState } from 'react';
import { Bot, Check, Pause, Play, RefreshCw, Settings, X } from 'lucide-react';
import type { Account, AiAction, AiBatchAction, AiSuggestion } from '../api/types';
import {
  useAiBatchDecision,
  useAiDecision,
  useAiStatus,
  useAiSuggestions,
  useMessage,
  useRunAi,
  useUpdateAiGlobalSettings,
} from '../hooks';
import { AiSettingsDialog } from './AiSettingsDialog';
import { MessageBody } from './MessageView';

const ACTION_LABEL: Record<AiAction, string> = {
  keep: 'Keep',
  mark_read: 'Mark read',
  archive: 'Archive',
  delete: 'Delete',
};

const ACTION_STYLE: Record<AiAction, string> = {
  keep: 'bg-neutral-200 text-neutral-700',
  mark_read: 'bg-blue-100 text-blue-700',
  archive: 'bg-amber-100 text-amber-700',
  delete: 'bg-red-100 text-red-700',
};

const ALL_ACTIONS: AiAction[] = ['keep', 'mark_read', 'archive', 'delete'];

// Order groups most-destructive first, so the actions needing scrutiny are on top.
const GROUP_ORDER: AiAction[] = ['delete', 'archive', 'mark_read', 'keep'];

export function ReviewPanel({ accounts }: { accounts: Account[] }) {
  const status = useAiStatus();
  const suggestions = useAiSuggestions('pending');
  const run = useRunAi();
  const batch = useAiBatchDecision();
  const updateGlobal = useUpdateAiGlobalSettings();
  const paused = status.data?.paused ?? false;
  const [showSettings, setShowSettings] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const labelFor = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
  const items = suggestions.data ?? [];

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleGroup = (ids: string[], select: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) (select ? next.add(id) : next.delete(id));
      return next;
    });

  const allSelected = items.length > 0 && items.every((s) => selected.has(s.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map((s) => s.id)));

  const applyBulk = (action: AiBatchAction) => {
    const ids = items.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (ids.length === 0) return;
    batch.mutate({ ids, action }, { onSuccess: () => setSelected(new Set()) });
  };

  return (
    <div className="flex h-full flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
        <div className="flex items-center gap-2">
          <Bot size={18} />
          <span className="text-sm font-semibold">AI Review</span>
          {status.data?.dryRun && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
              DRY RUN
            </span>
          )}
          {paused && (
            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-700">
              PAUSED
            </span>
          )}
          {status.data && !status.data.enabled && (
            <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs text-neutral-600">
              disabled
            </span>
          )}
          {status.data?.queueDepth ? (
            <span className="text-xs text-neutral-400">· {status.data.queueDepth} queued</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => updateGlobal.mutate({ paused: !paused })}
            disabled={updateGlobal.isPending || !status.data?.enabled}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
            title={paused ? 'Resume automatic triage' : 'Pause automatic triage'}
          >
            {paused ? <Play size={13} /> : <Pause size={13} />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={() => run.mutate()}
            disabled={run.isPending || !status.data?.enabled}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
            title="Run a triage pass now"
          >
            <RefreshCw size={13} className={run.isPending ? 'animate-spin' : ''} /> Run now
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="rounded p-1.5 hover:bg-neutral-100"
            title="AI settings"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>

      {/* Bulk action bar */}
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs">
          <label className="flex items-center gap-1.5 text-neutral-600">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
          </label>
          {selected.size > 0 && (
            <>
              <span className="mx-1 h-4 w-px bg-neutral-300" />
              <button
                onClick={() => applyBulk('approve')}
                disabled={batch.isPending}
                className="flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
                title="Apply each suggestion's own recommended action"
              >
                <Check size={12} /> Approve suggested
              </button>
              {ALL_ACTIONS.map((a) => (
                <button
                  key={a}
                  onClick={() => applyBulk(a)}
                  disabled={batch.isPending}
                  className="rounded-md border border-neutral-200 bg-white px-2 py-1 hover:bg-neutral-100 disabled:opacity-50"
                >
                  {ACTION_LABEL[a]}
                </button>
              ))}
              <button
                onClick={() => applyBulk('reject')}
                disabled={batch.isPending}
                className="rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
              >
                Dismiss
              </button>
              {batch.isPending && <RefreshCw size={12} className="animate-spin text-neutral-400" />}
            </>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {suggestions.isLoading && <p className="p-4 text-sm text-neutral-400">Loading…</p>}
        {suggestions.isError && (
          <p className="p-4 text-sm text-red-600">{(suggestions.error as Error).message}</p>
        )}
        {!suggestions.isLoading && items.length === 0 && (
          <p className="p-6 text-sm text-neutral-400">
            Nothing to review. New unread mail is triaged automatically.
          </p>
        )}
        <div className="mx-auto max-w-3xl space-y-5 p-4">
          {GROUP_ORDER.map((action) => {
            const group = items.filter((s) => s.action === action);
            if (group.length === 0) return null;
            const allInGroupSelected = group.every((s) => selected.has(s.id));
            return (
              <section key={action} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${ACTION_STYLE[action]}`}>
                    {ACTION_LABEL[action]}
                  </span>
                  <span className="text-xs text-neutral-400">{group.length}</span>
                  <button
                    onClick={() => toggleGroup(group.map((s) => s.id), !allInGroupSelected)}
                    className="text-xs text-neutral-500 hover:text-neutral-800 hover:underline"
                  >
                    {allInGroupSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="space-y-2">
                  {group.map((s) => (
                    <SuggestionCard
                      key={s.id}
                      s={s}
                      accountLabel={labelFor(s.accountId)}
                      selected={selected.has(s.id)}
                      onToggle={() => toggle(s.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {showSettings && (
        <AiSettingsDialog accounts={accounts} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

function SuggestionCard({
  s,
  accountLabel,
  selected,
  onToggle,
}: {
  s: AiSuggestion;
  accountLabel: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const decide = useAiDecision();
  const [open, setOpen] = useState(false);
  const pending = decide.isPending;
  const suggested = s.action;

  const act = (action: AiAction | 'reject') => decide.mutate({ id: s.id, action });

  return (
    <div
      className={`flex overflow-hidden rounded-lg border ${selected ? 'border-neutral-400 bg-neutral-50' : 'border-neutral-200'}`}
    >
      {/* Left rail: wide, full-height selection target. */}
      <button
        onClick={onToggle}
        aria-pressed={selected}
        title={selected ? 'Deselect' : 'Select'}
        className={`flex w-9 shrink-0 items-center justify-center self-stretch border-r transition-colors ${
          selected
            ? 'border-neutral-300 bg-neutral-800 text-white'
            : 'border-neutral-200 bg-neutral-50 text-transparent hover:bg-neutral-200/70 hover:text-neutral-400'
        }`}
      >
        <Check size={16} strokeWidth={3} />
      </button>

      {/* Body: click anywhere to open the email. */}
      <div onClick={() => setOpen(true)} className="min-w-0 flex-1 cursor-pointer p-3" title="View email">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-neutral-900">
              {s.subject || '(no subject)'}
            </div>
            <div className="truncate text-xs text-neutral-500">
              {s.fromAddr || 'unknown'} · {accountLabel} · {s.folderPath}
            </div>
          </div>
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${ACTION_STYLE[suggested]}`}>
            {ACTION_LABEL[suggested]}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
          {s.category && <span className="rounded bg-neutral-100 px-1.5 py-0.5">{s.category}</span>}
          {s.confidence != null && <span>{Math.round(s.confidence * 100)}% confident</span>}
        </div>
        {s.reasoning && <p className="mt-1.5 text-xs italic text-neutral-500">{s.reasoning}</p>}

        {open && <EmailModal s={s} accountLabel={accountLabel} onClose={() => setOpen(false)} />}

        <div
          className="mt-2.5 flex flex-wrap items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
        <button
          onClick={() => act(suggested)}
          disabled={pending}
          className="flex items-center gap-1 rounded-md bg-neutral-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          <Check size={13} /> Approve · {ACTION_LABEL[suggested]}
        </button>
        <span className="ml-1 text-xs text-neutral-400">or</span>
        {ALL_ACTIONS.filter((a) => a !== suggested).map((a) => (
          <button
            key={a}
            onClick={() => act(a)}
            disabled={pending}
            className="rounded-md border border-neutral-200 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50"
          >
            {ACTION_LABEL[a]}
          </button>
        ))}
        <button
          onClick={() => act('reject')}
          disabled={pending}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
          title="Dismiss without acting"
        >
          <X size={13} /> Dismiss
        </button>
        </div>
      </div>
    </div>
  );
}

/** Popup showing the full email. Lazily fetches via the normal message endpoint
 *  (BODY.PEEK), so previewing never marks mail read. */
function EmailModal({
  s,
  accountLabel,
  onClose,
}: {
  s: AiSuggestion;
  accountLabel: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = useMessage(s.accountId, s.folderPath, s.uid);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        // Modal is nested inside the clickable card — stop the backdrop click
        // from bubbling up and immediately re-opening it.
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-neutral-200 p-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{s.subject || '(no subject)'}</h2>
            <div className="truncate text-xs text-neutral-500">
              {s.fromAddr || 'unknown'} · {accountLabel} · {s.folderPath}
            </div>
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-neutral-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && <p className="text-sm text-neutral-400">Loading email…</p>}
          {isError && <p className="text-sm text-red-600">{(error as Error).message}</p>}
          {data && (
            <>
              {data.body.attachments.length > 0 && (
                <div className="mb-2 text-xs text-neutral-500">
                  {data.body.attachments.length} attachment(s)
                </div>
              )}
              <MessageBody html={data.body.html} text={data.body.text} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

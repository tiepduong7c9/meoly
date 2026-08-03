import { useState } from 'react';
import { X } from 'lucide-react';
import { btnPrimary, btnSecondary } from '../lib/buttons';
import type { Account, AiAction, AiGlobalSettingsPatch } from '../api/types';
import {
  useAiGlobalSettings,
  useAiSettings,
  useUpdateAiGlobalSettings,
  useUpdateAiSettings,
} from '../hooks';

type Tab = 'global' | 'mailbox';

const ACTIONS: { value: AiAction; label: string }[] = [
  { value: 'keep', label: 'Keep' },
  { value: 'mark_read', label: 'Mark read' },
  { value: 'archive', label: 'Archive' },
  { value: 'delete', label: 'Delete' },
];

export function AiSettingsDialog({
  accounts,
  onClose,
}: {
  accounts: Account[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('global');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">AI settings</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-neutral-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="mb-4 flex gap-1 rounded-lg bg-neutral-100 p-1 text-sm">
          {(['global', 'mailbox'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-md py-1 font-medium capitalize transition-colors ${
                tab === t ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {t === 'global' ? 'Global' : 'Mailbox'}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === 'global' ? (
            <GlobalForm onClose={onClose} />
          ) : accounts.length === 0 ? (
            <p className="text-sm text-neutral-400">Add a mailbox first to configure triage.</p>
          ) : (
            <div className="flex gap-4">
              {/* Mailbox list */}
              <div className="w-44 shrink-0 space-y-1 border-r border-neutral-200 pr-3">
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setAccountId(a.id)}
                    className={`block w-full truncate rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      accountId === a.id
                        ? 'bg-neutral-900 text-white'
                        : 'text-neutral-700 hover:bg-neutral-100'
                    }`}
                    title={a.label}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              {/* Selected mailbox form */}
              <div className="min-w-0 flex-1">
                {accountId && <AccountForm key={accountId} accountId={accountId} onClose={onClose} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  placeholder,
  value,
  type = 'text',
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  type?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-neutral-600">{label}</span>
      <input
        type={type}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Textarea({
  label,
  placeholder,
  value,
  rows = 4,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  rows?: number;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-neutral-600">{label}</span>
      <textarea
        rows={rows}
        className="w-full resize-y rounded-md border border-neutral-300 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-neutral-500"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

type SecretState = { value: string; touched: boolean };

function SecretField({
  label,
  placeholder,
  isSet,
  state,
  onChange,
}: {
  label: string;
  placeholder: string;
  isSet: boolean;
  state: SecretState;
  onChange: (v: SecretState) => void;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-neutral-600">{label}</span>
      <input
        type="password"
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        placeholder={!state.touched && isSet ? '•••• (configured)' : placeholder}
        value={state.value}
        onChange={(e) => onChange({ value: e.target.value, touched: true })}
      />
    </label>
  );
}

function GlobalForm({ onClose }: { onClose: () => void }) {
  const settings = useAiGlobalSettings();
  const update = useUpdateAiGlobalSettings();

  const [draft, setDraft] = useState<null | {
    paused: boolean;
    llmApiBaseUrl: string;
    llmModel: string;
    llmApiKey: SecretState;
    classifyPrompt: string;
    telegramBotToken: SecretState;
    telegramChatId: string;
  }>(null);

  const s = settings.data;
  const model =
    draft ??
    (s
      ? {
          paused: s.paused,
          llmApiBaseUrl: s.llmApiBaseUrl ?? '',
          llmModel: s.llmModel ?? '',
          llmApiKey: { value: '', touched: false },
          classifyPrompt: s.classifyPrompt ?? '',
          telegramBotToken: { value: '', touched: false },
          telegramChatId: s.telegramChatId ?? '',
        }
      : null);

  if (!model) return <p className="text-sm text-neutral-400">Loading…</p>;

  const set = (patch: Partial<typeof model>) => setDraft({ ...model, ...patch });

  const secretPatch = (f: SecretState): string | null | undefined =>
    f.touched ? (f.value.trim() || null) : undefined;

  const save = async () => {
    const patch: AiGlobalSettingsPatch = {
      paused: model.paused,
      llmApiBaseUrl: model.llmApiBaseUrl.trim() || null,
      llmModel: model.llmModel.trim() || null,
      llmApiKey: secretPatch(model.llmApiKey),
      classifyPrompt: model.classifyPrompt.trim() || null,
      telegramBotToken: secretPatch(model.telegramBotToken),
      telegramChatId: model.telegramChatId.trim() || null,
    };
    await update.mutateAsync(patch);
    onClose();
  };

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={model.paused}
          onChange={(e) => set({ paused: e.target.checked })}
        />
        Pause AI triage (stop automatic runs)
      </label>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">LLM</p>
        <Field
          label="API base URL"
          placeholder="http://localhost:1234/v1 (from env)"
          value={model.llmApiBaseUrl}
          onChange={(v) => set({ llmApiBaseUrl: v })}
        />
        <Field
          label="Model"
          placeholder="local-model (from env)"
          value={model.llmModel}
          onChange={(v) => set({ llmModel: v })}
        />
        <SecretField
          label="API key"
          placeholder="leave blank if not required"
          isSet={s?.llmApiKeySet ?? false}
          state={model.llmApiKey}
          onChange={(v) => set({ llmApiKey: v })}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            Classification prompt
          </p>
          <div className="flex gap-3 text-xs">
            <button
              type="button"
              className="text-neutral-500 hover:text-neutral-800 disabled:opacity-40"
              disabled={!s || model.classifyPrompt.trim() === s.defaultClassifyPrompt.trim()}
              onClick={() => s && set({ classifyPrompt: s.defaultClassifyPrompt })}
            >
              Load default to edit
            </button>
            <button
              type="button"
              className="text-neutral-500 hover:text-neutral-800 disabled:opacity-40"
              disabled={model.classifyPrompt === ''}
              onClick={() => set({ classifyPrompt: '' })}
            >
              Reset
            </button>
          </div>
        </div>
        <Textarea
          label="Instructions sent to the model for every message"
          placeholder="Blank uses the built-in default prompt."
          rows={8}
          value={model.classifyPrompt}
          onChange={(v) => set({ classifyPrompt: v })}
        />
        <p className="text-xs text-neutral-400">
          Describe how mail should be triaged — the required JSON response format is appended
          automatically. Use “Load default to edit” to start from the built-in prompt, then tweak it.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Telegram</p>
        <SecretField
          label="Bot token"
          placeholder="123456:ABC… (from env)"
          isSet={s?.telegramBotTokenSet ?? false}
          state={model.telegramBotToken}
          onChange={(v) => set({ telegramBotToken: v })}
        />
        <Field
          label="Chat ID"
          placeholder="-100… (from env)"
          value={model.telegramChatId}
          onChange={(v) => set({ telegramChatId: v })}
        />
        <p className="text-xs text-neutral-400">
          Leave blank to use environment variables. Telegram polling starts automatically once
          both fields are set.
        </p>
      </div>

      {update.isError && <p className="text-sm text-red-600">{(update.error as Error).message}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={btnPrimary} onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function AccountForm({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const settings = useAiSettings(accountId);
  const update = useUpdateAiSettings(accountId);

  const [draft, setDraft] = useState<null | {
    enabled: boolean;
    targetFolders: string;
    autoApply: boolean;
    autoApplyMinConf: number;
    autoApplyActions: AiAction[];
    customInstructions: string;
  }>(null);

  const s = settings.data;
  const model =
    draft ??
    (s
      ? {
          enabled: s.enabled,
          targetFolders: s.targetFolders.join(', '),
          autoApply: s.autoApply,
          autoApplyMinConf: s.autoApplyMinConf,
          autoApplyActions: s.autoApplyActions,
          customInstructions: s.customInstructions ?? '',
        }
      : null);

  if (!model) return <p className="text-sm text-neutral-400">Loading…</p>;

  const set = (patch: Partial<typeof model>) => setDraft({ ...model, ...patch });

  const toggleAction = (a: AiAction) =>
    set({
      autoApplyActions: model.autoApplyActions.includes(a)
        ? model.autoApplyActions.filter((x) => x !== a)
        : [...model.autoApplyActions, a],
    });

  const save = async () => {
    await update.mutateAsync({
      enabled: model.enabled,
      targetFolders: model.targetFolders
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
      autoApply: model.autoApply,
      autoApplyMinConf: model.autoApplyMinConf,
      autoApplyActions: model.autoApplyActions,
      customInstructions: model.customInstructions.trim() || null,
    });
    onClose();
  };

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-neutral-700">
        <input
          type="checkbox"
          checked={model.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        Triage this mailbox
      </label>

      <Field
        label="Folders to triage (comma-separated)"
        placeholder="INBOX"
        value={model.targetFolders}
        onChange={(v) => set({ targetFolders: v })}
      />

      <Textarea
        label="Extra instructions for this mailbox (optional)"
        placeholder="e.g. Keep anything from @work.com. Newsletters from Substack can be archived."
        rows={4}
        value={model.customInstructions}
        onChange={(v) => set({ customInstructions: v })}
      />

      <div className="rounded-lg border border-neutral-200 p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-neutral-700">
          <input
            type="checkbox"
            checked={model.autoApply}
            onChange={(e) => set({ autoApply: e.target.checked })}
          />
          Auto-apply high-confidence suggestions
        </label>

        <div className={model.autoApply ? 'mt-3 space-y-3' : 'mt-3 space-y-3 opacity-50'}>
          <label className="block text-sm">
            <span className="mb-1 block text-neutral-600">
              Minimum confidence: {Math.round(model.autoApplyMinConf * 100)}%
            </span>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.05}
              className="w-full"
              disabled={!model.autoApply}
              value={model.autoApplyMinConf}
              onChange={(e) => set({ autoApplyMinConf: Number(e.target.value) })}
            />
          </label>

          <div className="text-sm">
            <span className="mb-1 block text-neutral-600">Actions allowed to auto-apply</span>
            <div className="flex flex-wrap gap-2">
              {ACTIONS.map((a) => (
                <label key={a.value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    disabled={!model.autoApply}
                    checked={model.autoApplyActions.includes(a.value)}
                    onChange={() => toggleAction(a.value)}
                  />
                  {a.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {update.isError && <p className="text-sm text-red-600">{(update.error as Error).message}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className={btnSecondary} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={btnPrimary} onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

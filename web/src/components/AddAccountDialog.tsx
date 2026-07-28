import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAddAccount } from '../hooks';
import { PROVIDER_PRESETS } from '../presets';

export function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const addAccount = useAddAccount();
  const [preset, setPreset] = useState('gmail');
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [form, setForm] = useState({
    label: '',
    host: PROVIDER_PRESETS.gmail.host,
    port: 993,
    secure: true,
    username: '',
    password: '',
  });

  const update = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const onPreset = (key: string) => {
    setPreset(key);
    setOauthError(null);
    const p = PROVIDER_PRESETS[key];
    update({ host: p.host, port: p.port, secure: p.secure });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await addAccount.mutateAsync({
        ...form,
        label: form.label || form.username,
      });
      onClose();
    } catch {
      /* error surfaced below */
    }
  };

  // Outlook uses OAuth2: open Microsoft sign-in in a popup, and the account is
  // created server-side when the callback fires and posts back to us.
  const signInWithMicrosoft = async () => {
    setOauthError(null);
    setOauthBusy(true);
    let popup: Window | null = null;
    try {
      const { url } = await api.oauthStart('microsoft');
      popup = window.open(url, 'meoly-ms-oauth', 'width=520,height=720');
    } catch (e) {
      setOauthError((e as Error).message);
      setOauthBusy(false);
      return;
    }
    // window.open returns null when blocked — recover instead of hanging.
    if (!popup) {
      setOauthError('Popup was blocked — allow popups for this site and try again.');
      setOauthBusy(false);
      return;
    }

    const handler = (ev: MessageEvent) => {
      // The callback posts from the app's own origin; ignore anything else so a
      // forged message can't dismiss the dialog.
      if (ev.origin !== window.location.origin) return;
      if (!ev.data || ev.data.type !== 'meoly:oauth') return;
      window.removeEventListener('message', handler);
      clearInterval(timer);
      setOauthBusy(false);
      if (ev.data.ok) {
        qc.invalidateQueries({ queryKey: ['accounts'] });
        onClose();
      } else {
        setOauthError(ev.data.detail || 'Sign-in failed');
      }
    };
    window.addEventListener('message', handler);

    // Recover the UI if the user closes the popup without finishing.
    const timer = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(timer);
        window.removeEventListener('message', handler);
        setOauthBusy(false);
      }
    }, 500);
  };

  const field = 'w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500';
  const isOutlook = preset === 'outlook';

  const presetChips = (
    <div className="flex flex-wrap gap-2">
      {Object.entries(PROVIDER_PRESETS).map(([key, p]) => (
        <button
          type="button"
          key={key}
          onClick={() => onPreset(key)}
          className={`rounded-full border px-3 py-1 text-xs ${
            preset === key
              ? 'border-neutral-800 bg-neutral-800 text-white'
              : 'border-neutral-300 hover:bg-neutral-100'
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add mailbox</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-neutral-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {isOutlook ? (
          <div className="space-y-4">
            {presetChips}
            <p className="text-sm text-neutral-600">
              Outlook and Office 365 accounts sign in with Microsoft. A popup will open for you
              to authorize access to your mailbox.
            </p>
            {oauthError && <p className="text-sm text-red-600">{oauthError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label={oauthBusy ? 'Waiting for Microsoft…' : 'Sign in with Microsoft'}
                variant="primary"
                onClick={signInWithMicrosoft}
                isDisabled={oauthBusy}
              />
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {presetChips}

            <input
              className={field}
              placeholder="Display name (optional)"
              value={form.label}
              onChange={(e) => update({ label: e.target.value })}
            />
            <div className="flex gap-2">
              <input
                className={field}
                placeholder="IMAP host"
                value={form.host}
                onChange={(e) => update({ host: e.target.value })}
                required
              />
              <input
                className="w-24 rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
                type="number"
                placeholder="Port"
                value={form.port}
                onChange={(e) => update({ port: Number(e.target.value) })}
                required
              />
            </div>
            <input
              className={field}
              placeholder="Email / username"
              value={form.username}
              autoComplete="username"
              onChange={(e) => update({ username: e.target.value })}
              required
            />
            <input
              className={field}
              type="password"
              placeholder="App password"
              value={form.password}
              autoComplete="current-password"
              onChange={(e) => update({ password: e.target.value })}
              required
            />

            <label className="flex items-center gap-2 text-sm text-neutral-600">
              <input
                type="checkbox"
                checked={form.secure}
                onChange={(e) => update({ secure: e.target.checked })}
              />
              Use TLS (port 993)
            </label>

            {addAccount.isError && (
              <p className="text-sm text-red-600">{(addAccount.error as Error).message}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label={addAccount.isPending ? 'Connecting…' : 'Add mailbox'}
                variant="primary"
                type="submit"
                isDisabled={addAccount.isPending}
              />
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

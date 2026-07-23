import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { useAddAccount } from '../hooks';
import { PROVIDER_PRESETS } from '../presets';

export function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const addAccount = useAddAccount();
  const [preset, setPreset] = useState('gmail');
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

  const field = 'w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add mailbox</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-neutral-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
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
      </div>
    </div>
  );
}

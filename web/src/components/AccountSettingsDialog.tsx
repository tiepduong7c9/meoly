import { X, Trash, Mail } from 'lucide-react';
import { btnSecondary } from '../lib/buttons';
import type { Account } from '../api/types';
import { useDeleteAccount } from '../hooks';

export function AccountSettingsDialog({
  accounts,
  onClose,
}: {
  accounts: Account[];
  onClose: () => void;
}) {
  const deleteAccount = useDeleteAccount();

  const remove = (account: Account) => {
    if (confirm(`Remove ${account.label}? Cached mail will be deleted.`)) {
      deleteAccount.mutate(account.id);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Manage mailboxes</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-neutral-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {accounts.length === 0 ? (
          <p className="py-6 text-center text-sm text-neutral-500">No mailboxes added yet.</p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3"
              >
                <Mail size={18} className="shrink-0 text-neutral-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-neutral-900">{account.label}</p>
                  <p className="truncate text-xs text-neutral-500">
                    {account.username} · {account.host}
                  </p>
                </div>
                <button
                  onClick={() => remove(account)}
                  disabled={deleteAccount.isPending}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
                  aria-label={`Remove ${account.label}`}
                >
                  <Trash size={14} />
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {deleteAccount.isError && (
          <p className="mt-3 text-sm text-red-600">{(deleteAccount.error as Error).message}</p>
        )}

        <div className="mt-5 flex justify-end">
          <button type="button" className={btnSecondary} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Mail } from 'lucide-react';
import { api, setToken } from './api/client';

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [code, setCode] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.replace(/\s/g, '').length < 6) return;
    setLoading(true);
    setLoginError('');
    try {
      const { token } = await api.login(code);
      setToken(token);
      onLogin();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Login failed');
      setCode('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const field =
    'w-full rounded-md border border-neutral-300 px-3 py-2 text-center text-2xl tracking-widest outline-none focus:border-neutral-500';

  return (
    <div className="flex h-full w-full items-center justify-center bg-neutral-50">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-lg">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Mail size={36} strokeWidth={1.2} className="text-neutral-400" />
          <h1 className="text-xl font-semibold text-neutral-900">Meoly</h1>
          <p className="text-sm text-neutral-500">Enter your authenticator code</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            pattern="[0-9 ]*"
            maxLength={7}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
            className={field}
            autoComplete="one-time-code"
            disabled={loading}
          />
          {loginError && <p className="text-center text-sm text-red-600">{loginError}</p>}
          <button
            type="submit"
            disabled={loading || code.length < 6}
            className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {loading ? 'Verifying…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-neutral-400">
          First time? Check the server console for the setup URL.
        </p>
      </div>
    </div>
  );
}

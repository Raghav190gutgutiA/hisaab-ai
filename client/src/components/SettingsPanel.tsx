import { useEffect, useState } from 'react';
import { Send, X } from 'lucide-react';
import { api } from '../lib/api.ts';
import type { User } from '../type.ts';

type Status = Awaited<ReturnType<typeof api.telegramStatus>>;

export function SettingsPanel({
  user,
  onClose,
  onLogout,
}: {
  user: User;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<{ code: string; expiresAt: string; deepLink: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setStatus(await api.telegramStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Telegram status');
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Poll while a link code is pending so the panel updates once the bot links the chat
  useEffect(() => {
    if (!link || status?.linked) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [link, status?.linked]);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.telegramLinkCode();
      setLink(result);
      if (result.deepLink) window.open(result.deepLink, '_blank', 'noopener');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a link code');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.telegramDisconnect();
      setLink(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(false);
    }
  }

  const expiresAt = link && new Date(link.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-24" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Settings"
        className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 space-y-6"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-100">Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-zinc-400 hover:text-zinc-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <section className="space-y-1">
          <div className="text-sm text-zinc-400">Signed in as</div>
          <div className="text-zinc-100">{user.name}</div>
          <div className="text-sm text-zinc-500">{user.email}</div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2 text-zinc-100 font-medium">
            <Send className="w-4 h-4 text-sky-400" /> Telegram
          </div>

          {!status ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : !status.enabled ? (
            <p className="text-sm text-zinc-500">The Telegram bot is not configured on the server.</p>
          ) : status.linked ? (
            <>
              <p className="text-sm text-green-400">
                ✅ Connected{status.botUsername && <> to @{status.botUsername}</>}
              </p>
              <button
                type="button"
                onClick={disconnect}
                disabled={busy}
                className="rounded-xl px-4 py-2 text-sm border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                Disconnect Telegram
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-zinc-400">
                Log and view expenses from Telegram, e.g. send <code className="text-zinc-200">tea 20, taxi 80</code>.
              </p>
              <button
                type="button"
                onClick={connect}
                disabled={busy}
                className="rounded-xl px-4 py-2 text-sm font-medium text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-50">
                {link ? 'Generate a new code' : 'Connect Telegram'}
              </button>
              {link && (
                <div className="rounded-xl bg-zinc-800/60 p-3 text-sm text-zinc-300 space-y-2">
                  {link.deepLink && (
                    <p>
                      Telegram should have opened.{' '}
                      <a href={link.deepLink} target="_blank" rel="noopener" className="text-sky-400 underline">
                        Open it again
                      </a>{' '}
                      and tap <b>Start</b>.
                    </p>
                  )}
                  <p>Or send this to the bot:</p>
                  <code className="block select-all rounded-lg bg-zinc-950 px-3 py-2 text-zinc-100 break-all">
                    /link {link.code}
                  </code>
                  <p className="text-xs text-zinc-500">One-time code, expires at {expiresAt}. Waiting for Telegram…</p>
                </div>
              )}
            </>
          )}
        </section>

        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

        <button type="button" onClick={onLogout} className="text-sm text-zinc-400 hover:text-zinc-100">
          Log out
        </button>
      </div>
    </div>
  );
}

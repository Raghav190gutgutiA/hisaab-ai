import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../lib/api.ts';
import { formatDate, formatPaise } from '../lib/format.ts';
import type { Expense } from '../type.ts';

type Props = {
  matches: Expense[];
  totalPaise: number;
  token: string | null;
  tooMany: boolean;
};

/**
 * Shown when the user asks to delete expenses. Nothing is removed until
 * they press Delete; the token makes the request single use.
 */
export function DeleteConfirmCard({ matches, totalPaise, token, tooMany }: Props) {
  const [state, setState] = useState<'pending' | 'busy' | 'deleted' | 'cancelled' | 'error'>('pending');
  const [message, setMessage] = useState<string | null>(null);

  if (tooMany || matches.length === 0) {
    return (
      <div className="max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
        {tooMany
          ? 'That matches too many expenses. Add a date or an amount to narrow it down.'
          : "I couldn't find a matching expense."}
      </div>
    );
  }

  async function confirm() {
    if (!token) return;
    setState('busy');
    try {
      const result = await api.confirmDelete(token);
      setState('deleted');
      setMessage(
        `Deleted ${result.deleted.length} ${result.deleted.length === 1 ? 'expense' : 'expenses'} (${formatPaise(result.totalPaise)}).`
      );
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Could not delete. Please try again.');
    }
  }

  async function cancel() {
    setState('cancelled');
    if (token) await api.cancelDelete(token).catch(() => {});
  }

  const done = state === 'deleted' || state === 'cancelled' || state === 'error';

  return (
    <div className="max-w-md rounded-xl border border-zinc-800 bg-zinc-900">
      <ul className={`divide-y divide-zinc-800 ${state === 'deleted' ? 'opacity-50 line-through' : ''}`}>
        {matches.map((e) => (
          <li key={e.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className="text-zinc-200">
              {e.title}{' '}
              <span className="text-xs text-zinc-500">
                · {e.category} · {formatDate(e.spentOn)}
              </span>
            </span>
            <span className="text-zinc-100 tabular-nums">{formatPaise(e.amountPaise)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3">
        {done ? (
          <p role="status" className={`text-sm ${state === 'error' ? 'text-red-400' : 'text-zinc-400'}`}>
            {state === 'cancelled' ? 'Okay, nothing was deleted.' : message}
          </p>
        ) : (
          <>
            <span className="text-xs text-zinc-500">Total {formatPaise(totalPaise)}</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={cancel}
                disabled={state === 'busy'}
                className="rounded-lg px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={state === 'busy'}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-500 disabled:opacity-50">
                <Trash2 className="w-3.5 h-3.5" aria-hidden />
                Delete {matches.length}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

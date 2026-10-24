import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { api } from '../lib/api.ts';
import { BudgetMeter, type BudgetStatus } from './BudgetCard.tsx';

/** Monthly budget section of the Settings panel. */
export function BudgetSettings() {
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getBudget()
      .then(({ status }) => {
        setStatus(status);
        if (status) setAmount(String(status.budgetPaise / 100));
      })
      .catch(() => setError('Could not load your budget'))
      .finally(() => setLoaded(true));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 1) {
      setError('Enter a budget of at least ₹1');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus((await api.setBudget(value)).status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the budget');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.clearBudget();
      setStatus(null);
      setAmount('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the budget');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-zinc-100 font-medium">
        <Wallet className="w-4 h-4 text-purple-400" /> Monthly budget
      </div>

      {!loaded ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {status && <BudgetMeter status={status} />}
          <form onSubmit={save} className="flex gap-2">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">₹</span>
              <input
                type="number"
                inputMode="decimal"
                min={1}
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="20000"
                aria-label="Monthly budget in rupees"
                className="w-full rounded-xl bg-zinc-950 border border-zinc-700 pl-7 pr-3 py-2 text-zinc-100 focus:outline-none focus:border-purple-500"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-500 disabled:opacity-50">
              {status ? 'Update' : 'Set'}
            </button>
          </form>
          {status && (
            <button type="button" onClick={remove} disabled={busy} className="text-xs text-zinc-500 hover:text-zinc-300">
              Remove budget
            </button>
          )}
          <p className="text-xs text-zinc-500">
            You'll get a warning with tips when you reach 80% of the budget, and again if you cross it.
          </p>
        </>
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </section>
  );
}

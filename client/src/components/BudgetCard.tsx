import { AlertTriangle, CheckCircle2, OctagonAlert } from 'lucide-react';
import { formatPaise } from '../lib/format.ts';

export type BudgetStatus = {
  month: string;
  budgetPaise: number;
  spentPaise: number;
  remainingPaise: number;
  usedPct: number;
  daysLeft: number;
  dailyAllowancePaise: number;
  topFlexible: { category: string; totalPaise: number } | null;
};

function monthName(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' });
}

/** State of the budget, always shown with an icon and a label, never colour alone. */
function budgetState(usedPct: number) {
  if (usedPct >= 100) return { label: 'Over budget', Icon: OctagonAlert, tone: 'text-red-400', bar: 'bg-red-400' };
  if (usedPct >= 80) return { label: 'Almost used up', Icon: AlertTriangle, tone: 'text-amber-400', bar: 'bg-amber-400' };
  return { label: 'On track', Icon: CheckCircle2, tone: 'text-emerald-400', bar: 'bg-purple-400' };
}

/** Progress bar for a monthly budget, used in chat and in Settings. */
export function BudgetMeter({ status }: { status: BudgetStatus }) {
  const state = budgetState(status.usedPct);
  const over = status.remainingPaise < 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-400">{monthName(status.month)} budget</span>
        <span className={`inline-flex items-center gap-1 ${state.tone}`}>
          <state.Icon className="w-3.5 h-3.5" aria-hidden />
          {state.label}
        </span>
      </div>
      <div
        className="h-2.5 rounded-full bg-zinc-800 overflow-hidden"
        role="progressbar"
        aria-valuenow={Math.round(status.usedPct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${Math.round(status.usedPct)}% of budget used`}>
        <div className={`h-full rounded-full ${state.bar}`} style={{ width: `${Math.min(status.usedPct, 100)}%` }} />
      </div>
      <div className="flex justify-between text-sm tabular-nums">
        <span className="text-zinc-100">
          {formatPaise(status.spentPaise)} <span className="text-zinc-500">of {formatPaise(status.budgetPaise)}</span>
        </span>
        <span className="text-zinc-400">{Math.round(status.usedPct)}%</span>
      </div>
      <div className="text-xs text-zinc-400">
        {over
          ? `${formatPaise(-status.remainingPaise)} over budget · ${status.daysLeft} days left in the month`
          : `${formatPaise(status.remainingPaise)} left · about ${formatPaise(status.dailyAllowancePaise)}/day for ${status.daysLeft} days`}
      </div>
    </div>
  );
}

export function BudgetCard({ status, action }: { status: BudgetStatus | null; action: 'set' | 'status' | 'cleared' }) {
  return (
    <div className="max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      {status ? (
        <BudgetMeter status={status} />
      ) : (
        <p className="text-sm text-zinc-400">
          {action === 'cleared' ? 'Monthly budget removed.' : 'No monthly budget set yet.'}
        </p>
      )}
    </div>
  );
}

/** Warning shown under an expense confirmation at 80% / 100% of the budget. */
export function BudgetAlertBanner({ level, status }: { level: 80 | 100; status: BudgetStatus }) {
  const critical = level === 100;
  const Icon = critical ? OctagonAlert : AlertTriangle;
  const tip = status.topFlexible
    ? ` ${status.topFlexible.category} is your biggest flexible spend (${formatPaise(status.topFlexible.totalPaise)}), so that's the easiest place to cut back.`
    : '';

  return (
    <div
      role="alert"
      className={`max-w-md rounded-xl border p-3 text-sm ${
        critical ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-100'
      }`}>
      <div className="flex items-center gap-2 font-medium">
        <Icon className="w-4 h-4 shrink-0" aria-hidden />
        {critical ? 'Budget crossed' : `${Math.floor(status.usedPct)}% of budget used`}
      </div>
      <p className="mt-1 text-xs leading-5 opacity-90">
        {critical
          ? `You've spent ${formatPaise(status.spentPaise)} of your ${formatPaise(status.budgetPaise)} budget. Try to stick to essentials for the remaining ${status.daysLeft} days.`
          : `${formatPaise(status.remainingPaise)} left for ${status.daysLeft} days, about ${formatPaise(status.dailyAllowancePaise)} a day.`}
        {tip}
      </p>
    </div>
  );
}

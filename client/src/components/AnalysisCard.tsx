import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { formatDate, formatPaise } from '../lib/format.ts';

export type ExpenseAnalysis = {
  type: 'analysis';
  from: string;
  to: string;
  categories: string[];
  days: number;
  count: number;
  totalPaise: number;
  avgPerDayPaise: number;
  avgPerExpensePaise: number;
  byCategory: { category: string; totalPaise: number; count: number; sharePct: number }[];
  topExpenses: { title: string; category: string; amountPaise: number; spentOn: string }[];
  biggestDay: { date: string; totalPaise: number } | null;
  previous: { from: string; to: string; totalPaise: number; count: number; changePct: number | null };
};

function StatTile({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-100 tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-400">{hint}</div>}
    </div>
  );
}

function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span>No spending in the previous period</span>;
  const Icon = pct > 0 ? ArrowUpRight : pct < 0 ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex items-center gap-0.5">
      <Icon className="w-3.5 h-3.5" aria-hidden />
      {Math.abs(pct)}% {pct > 0 ? 'more' : pct < 0 ? 'less' : 'same'} than previous period
    </span>
  );
}

/**
 * Generative UI for analyze_expenses: headline stats, category shares and
 * top expenses. The model's written insights stream in below this card.
 */
export function AnalysisCard({ analysis }: { analysis: ExpenseAnalysis }) {
  const scope = analysis.categories.length ? analysis.categories.join(' & ') : 'All categories';
  const maxShare = Math.max(...analysis.byCategory.map((c) => c.sharePct), 1);

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs text-zinc-500">
          <span className="text-purple-300 font-medium">{scope}</span> · {formatDate(analysis.from)} –{' '}
          {formatDate(analysis.to)} ({analysis.days} {analysis.days === 1 ? 'day' : 'days'})
        </div>
        <div className="text-sm font-medium text-zinc-200">Spending analysis</div>
      </div>

      {analysis.count === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500 text-center">
          No expenses in this period.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile
              label="Total spent"
              value={formatPaise(analysis.totalPaise)}
              hint={<Change pct={analysis.previous.changePct} />}
            />
            <StatTile label="Average per day" value={formatPaise(analysis.avgPerDayPaise)} />
            <StatTile
              label="Expenses"
              value={String(analysis.count)}
              hint={`avg ${formatPaise(analysis.avgPerExpensePaise)} each`}
            />
            <StatTile
              label="Biggest day"
              value={analysis.biggestDay ? formatPaise(analysis.biggestDay.totalPaise) : '—'}
              hint={analysis.biggestDay && formatDate(analysis.biggestDay.date)}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="text-xs font-medium text-zinc-400 mb-3">By category</div>
              <ul className="space-y-2.5">
                {analysis.byCategory.map((c) => (
                  <li
                    key={c.category}
                    title={`${c.category}: ${formatPaise(c.totalPaise)} · ${c.count} expenses · ${c.sharePct}%`}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-zinc-200">{c.category}</span>
                      <span className="text-zinc-400 tabular-nums">
                        {formatPaise(c.totalPaise)} · {c.sharePct}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-zinc-800">
                      <div
                        className="h-2 rounded-full bg-purple-400"
                        style={{ width: `${Math.max((c.sharePct / maxShare) * 100, 2)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="text-xs font-medium text-zinc-400 mb-3">Top expenses</div>
              <ol className="space-y-2">
                {analysis.topExpenses.map((t, i) => (
                  <li key={`${t.title}-${i}`} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-zinc-200">
                      <span className="text-zinc-500 tabular-nums mr-1.5">{i + 1}.</span>
                      {t.title}
                      <span className="text-xs text-zinc-500"> · {t.category} · {formatDate(t.spentOn)}</span>
                    </span>
                    <span className="shrink-0 text-zinc-100 tabular-nums">{formatPaise(t.amountPaise)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

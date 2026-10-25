import { useState } from 'react';
import type { Expense, ExpenseFormat, ExpenseSummary } from '../type.ts';
import { api } from '../lib/api.ts';
import { formatDate, formatPaise, summarizeExpenses, toDailyChartData, toExpenseJson } from '../lib/format.ts';
import { ExpenseTable } from './ExpenseTable.tsx';
import { JsonViewer } from './JsonViewer.tsx';
import { ExpenseChart } from './ExpenseChart.tsx';
import { CategoryPie } from './CategoryPie.tsx';
import { FORMAT_OPTIONS } from '../lib/formatOptions.ts';

type ChartType = 'bar' | 'pie';

type Props = {
  format: ExpenseFormat;
  expenses: Expense[];
  summary: ExpenseSummary;
  chartType?: ChartType;
};

/**
 * Renders a show_expenses result in the chosen format, with a small
 * switcher that also updates the saved preference. Rows deleted from the
 * table disappear here and the totals update.
 */
export function ExpenseView({ format: initialFormat, expenses: initialExpenses, summary: initialSummary, chartType: initialChart }: Props) {
  const [format, setFormat] = useState(initialFormat);
  const [chartType, setChartType] = useState<ChartType>(initialChart ?? 'bar');
  const [expenses, setExpenses] = useState(initialExpenses);
  const summary = expenses === initialExpenses ? initialSummary : summarizeExpenses(expenses, initialSummary);

  function switchTo(next: ExpenseFormat) {
    setFormat(next);
    api.setExpenseFormat(next).catch(() => {
      // Switching the view still works if saving the preference fails
    });
  }

  async function deleteExpense(expense: Expense) {
    await api.deleteExpense(expense.id);
    setExpenses((current) => current.filter((e) => e.id !== expense.id));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-500">
            {summary.categories.length > 0 && (
              <span className="text-purple-300 font-medium">{summary.categories.join(' & ')} · </span>
            )}
            {formatDate(summary.from)} – {formatDate(summary.to)}
          </div>
          <div className="text-2xl font-semibold text-zinc-100 tabular-nums">
            {formatPaise(summary.totalPaise)}
            <span className="ml-2 text-sm font-normal text-zinc-500">
              {summary.count} {summary.count === 1 ? 'expense' : 'expenses'}
            </span>
          </div>
        </div>
        <div role="tablist" aria-label="Display format" className="inline-flex rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
          {FORMAT_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={format === value}
              onClick={() => switchTo(value)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
                format === value ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
              }`}>
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {summary.byCategory.length > 0 && format !== 'chart' && (
        <div className="flex flex-wrap gap-2">
          {summary.byCategory.map((c) => (
            <span key={c.category} className="px-2.5 py-1 rounded-full text-xs bg-zinc-800/70 text-zinc-300">
              {c.category} <span className="text-zinc-100 tabular-nums">{formatPaise(c.totalPaise)}</span>
            </span>
          ))}
        </div>
      )}

      {expenses.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500 text-center">
          No expenses in this period.
        </div>
      ) : format === 'table' ? (
        <ExpenseTable expenses={expenses} totalPaise={summary.totalPaise} onDelete={deleteExpense} />
      ) : format === 'json' ? (
        <JsonViewer data={toExpenseJson(expenses, summary)} />
      ) : (
        <div className="space-y-2">
          <div role="tablist" aria-label="Chart type" className="inline-flex rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
            {(['bar', 'pie'] as const).map((type) => (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={chartType === type}
                onClick={() => setChartType(type)}
                className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                  chartType === type ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}>
                {type === 'bar' ? 'Daily bars' : 'Category pie'}
              </button>
            ))}
          </div>
          {chartType === 'pie' ? (
            <CategoryPie byCategory={summary.byCategory} />
          ) : (
            <ExpenseChart chartData={toDailyChartData(expenses)} labelKey="date" />
          )}
        </div>
      )}
    </div>
  );
}

import type { Expense, ExpenseSummary } from '../type.ts';

const inr = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

/** Amounts arrive as integer paise; 2000 -> "₹20" */
export function formatPaise(paise: number): string {
  return `₹${inr.format(paise / 100)}`;
}

export function formatDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * JSON-to-table mapping: each expense document becomes one row with the
 * same columns in the table view, the JSON view and the Telegram bot.
 */
export type ExpenseRow = {
  date: string;
  description: string;
  category: string;
  amount_inr: number;
};

export function toExpenseRow(expense: Expense): ExpenseRow {
  return {
    date: expense.spentOn,
    description: expense.title,
    category: expense.category,
    amount_inr: expense.amountPaise / 100,
  };
}

export function toExpenseJson(expenses: Expense[], summary: ExpenseSummary) {
  return {
    from: summary.from,
    to: summary.to,
    ...(summary.categories.length > 0 && { categories: summary.categories }),
    total_inr: summary.totalPaise / 100,
    count: summary.count,
    expenses: expenses.map(toExpenseRow),
  };
}

/** Recomputes totals after rows were deleted, keeping the original range and filter. */
export function summarizeExpenses(expenses: Expense[], base: ExpenseSummary): ExpenseSummary {
  const totals = new Map<string, number>();
  for (const e of expenses) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amountPaise);
  return {
    ...base,
    count: expenses.length,
    totalPaise: expenses.reduce((sum, e) => sum + e.amountPaise, 0),
    byCategory: [...totals.entries()]
      .map(([category, totalPaise]) => ({ category, totalPaise }))
      .sort((a, b) => b.totalPaise - a.totalPaise),
  };
}

/** Daily totals in rupees for the bar chart. */
export function toDailyChartData(expenses: Expense[]) {
  const totals = new Map<string, number>();
  for (const e of expenses) {
    totals.set(e.spentOn, (totals.get(e.spentOn) ?? 0) + e.amountPaise);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, paise]) => ({ date, amount: paise / 100 }));
}

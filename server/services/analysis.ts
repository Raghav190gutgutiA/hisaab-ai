import type { Category, Expense, ExpenseQuery } from './expenses.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type ExpenseAnalysis = {
  type: 'analysis';
  from: string;
  to: string;
  /** Categories analysed; empty means all */
  categories: Category[];
  days: number;
  count: number;
  totalPaise: number;
  avgPerDayPaise: number;
  avgPerExpensePaise: number;
  byCategory: { category: Category; totalPaise: number; count: number; sharePct: number }[];
  topExpenses: { title: string; category: Category; amountPaise: number; spentOn: string }[];
  biggestDay: { date: string; totalPaise: number } | null;
  byWeekday: { day: (typeof WEEKDAYS)[number]; totalPaise: number }[];
  previous: {
    from: string;
    to: string;
    totalPaise: number;
    count: number;
    /** null when the previous period had no spending */
    changePct: number | null;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (date: Date) => date.toISOString().slice(0, 10);

export function daysInRange(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY_MS) + 1;
}

/** The equally long period right before `from`, for comparison. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = daysInRange(from, to);
  const prevTo = new Date(toDate(from).getTime() - DAY_MS);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * DAY_MS);
  return { from: toIso(prevFrom), to: toIso(prevTo) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Deterministic spending analysis. All maths happens here (in integer
 * paise), so the model only has to describe the numbers, never compute them.
 */
export function computeAnalysis(
  expenses: Expense[],
  previousExpenses: Expense[],
  query: ExpenseQuery
): ExpenseAnalysis {
  const days = daysInRange(query.from, query.to);
  const totalPaise = expenses.reduce((sum, e) => sum + e.amountPaise, 0);
  const previousTotal = previousExpenses.reduce((sum, e) => sum + e.amountPaise, 0);

  const categories = new Map<Category, { totalPaise: number; count: number }>();
  const dailyTotals = new Map<string, number>();
  const weekday = new Array<number>(7).fill(0);

  for (const e of expenses) {
    const c = categories.get(e.category) ?? { totalPaise: 0, count: 0 };
    c.totalPaise += e.amountPaise;
    c.count += 1;
    categories.set(e.category, c);
    dailyTotals.set(e.spentOn, (dailyTotals.get(e.spentOn) ?? 0) + e.amountPaise);
    weekday[toDate(e.spentOn).getUTCDay()] += e.amountPaise;
  }

  let biggestDay: ExpenseAnalysis['biggestDay'] = null;
  for (const [date, total] of dailyTotals) {
    if (!biggestDay || total > biggestDay.totalPaise) biggestDay = { date, totalPaise: total };
  }

  const previous = previousPeriod(query.from, query.to);

  return {
    type: 'analysis',
    from: query.from,
    to: query.to,
    categories: [...new Set(query.categories ?? [])],
    days,
    count: expenses.length,
    totalPaise,
    avgPerDayPaise: Math.round(totalPaise / days),
    avgPerExpensePaise: expenses.length ? Math.round(totalPaise / expenses.length) : 0,
    byCategory: [...categories.entries()]
      .map(([category, c]) => ({
        category,
        totalPaise: c.totalPaise,
        count: c.count,
        sharePct: totalPaise ? round1((c.totalPaise / totalPaise) * 100) : 0,
      }))
      .sort((a, b) => b.totalPaise - a.totalPaise),
    topExpenses: [...expenses]
      .sort((a, b) => b.amountPaise - a.amountPaise)
      .slice(0, 5)
      .map(({ title, category, amountPaise, spentOn }) => ({ title, category, amountPaise, spentOn })),
    biggestDay,
    byWeekday: WEEKDAYS.map((day, i) => ({ day, totalPaise: weekday[i] })),
    previous: {
      ...previous,
      totalPaise: previousTotal,
      count: previousExpenses.length,
      changePct: previousTotal ? round1(((totalPaise - previousTotal) / previousTotal) * 100) : null,
    },
  };
}

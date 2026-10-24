import { ObjectId } from 'mongodb';
import * as z from 'zod';
import { fromBsonInt, toBsonInt, type Collections, type ExpenseDoc } from '../db.ts';
import { isValidIsoDate } from '../dates.ts';
import { formatPaise } from '../money.ts';

export const CATEGORIES = [
  'Food',
  'Groceries',
  'Travel',
  'Shopping',
  'Bills',
  'Rent',
  'Entertainment',
  'Health',
  'Education',
  'Other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const isoDateSchema = z
  .string()
  .refine(isValidIsoDate, 'Must be a valid date in YYYY-MM-DD format');

export const dateRangeSchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .refine((range) => range.from <= range.to, {
    message: '`from` must be on or before `to`',
  });

export const categorySchema = z.enum(CATEGORIES);

/** A date range, optionally narrowed to some categories ("food aur travel ka chart"). */
export type ExpenseQuery = {
  from: string;
  to: string;
  categories?: Category[] | null;
};

/** ["Food", "Travel"] -> "Food & Travel"; empty means all categories */
export function describeCategories(categories: Category[]): string | null {
  return categories.length ? categories.join(' & ') : null;
}

export const newExpenseSchema = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.enum(CATEGORIES),
  amountPaise: z
    .number()
    .int()
    .positive()
    .max(100_000_000_00, 'Amount is unrealistically large'),
  spentOn: isoDateSchema,
});

export type NewExpense = z.infer<typeof newExpenseSchema>;

export type Expense = {
  id: string;
  title: string;
  category: Category;
  amountPaise: number;
  spentOn: string;
};

export type CategoryTotal = { category: Category; totalPaise: number };

export type ExpenseSummary = {
  from: string;
  to: string;
  /** Categories the list was filtered to; empty means all */
  categories: Category[];
  count: number;
  totalPaise: number;
  byCategory: CategoryTotal[];
};

/** Maps a stored document (snake_case columns) to the API shape. */
function matchQuery(userId: string, query: ExpenseQuery) {
  const { from, to } = dateRangeSchema.parse(query);
  const categories = z.array(categorySchema).nullish().parse(query.categories);
  return {
    user_id: toObjectId(userId),
    spent_on: { $gte: from, $lte: to },
    ...(categories?.length && { category: { $in: categories } }),
  };
}

function toExpense(doc: ExpenseDoc): Expense {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    category: doc.category as Category,
    amountPaise: fromBsonInt(doc.amount_paise),
    spentOn: doc.spent_on,
  };
}

export function toObjectId(id: string): ObjectId {
  if (!ObjectId.isValid(id)) throw new Error('Invalid id');
  return new ObjectId(id);
}

/**
 * Every function takes userId explicitly; there is no way to read or write
 * expenses without scoping to a user.
 */
export function createExpenseService({ expenses }: Collections) {
  async function addExpenses(
    userId: string,
    items: NewExpense[]
  ): Promise<Expense[]> {
    const parsed = z.array(newExpenseSchema).min(1).parse(items);
    const userObjectId = toObjectId(userId);
    const now = new Date();

    const docs: ExpenseDoc[] = parsed.map((item) => ({
      _id: new ObjectId(),
      user_id: userObjectId,
      title: item.title,
      category: item.category,
      amount_paise: toBsonInt(item.amountPaise),
      spent_on: item.spentOn,
      created_at: now,
    }));

    await expenses.insertMany(docs);
    return docs.map(toExpense);
  }

  async function listExpenses(
    userId: string,
    query: ExpenseQuery
  ): Promise<Expense[]> {
    const docs = await expenses
      .find(matchQuery(userId, query))
      .sort({ spent_on: 1, _id: 1 })
      .toArray();
    return docs.map(toExpense);
  }

  async function aggregateByPeriod(
    userId: string,
    query: ExpenseQuery,
    groupBy: 'date' | 'week' | 'month'
  ): Promise<{ period: string; totalPaise: number }[]> {
    const period = {
      date: '$spent_on',
      week: {
        $dateToString: {
          format: '%G-W%V',
          date: { $dateFromString: { dateString: '$spent_on' } },
        },
      },
      month: { $substrBytes: ['$spent_on', 0, 7] },
    }[groupBy];

    const rows = await expenses
      .aggregate<{ _id: string; total: number }>([
        { $match: matchQuery(userId, query) },
        { $group: { _id: period, total: { $sum: '$amount_paise' } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    return rows.map((row) => ({
      period: row._id,
      totalPaise: Number(row.total),
    }));
  }

  return { addExpenses, listExpenses, aggregateByPeriod };
}

export type ExpenseService = ReturnType<typeof createExpenseService>;

export function summarize(
  expenses: Pick<Expense, 'category' | 'amountPaise'>[],
  query: ExpenseQuery
): ExpenseSummary {
  const totals = new Map<Category, number>();
  for (const expense of expenses) {
    totals.set(
      expense.category,
      (totals.get(expense.category) ?? 0) + expense.amountPaise
    );
  }

  return {
    from: query.from,
    to: query.to,
    categories: [...new Set(query.categories ?? [])],
    count: expenses.length,
    totalPaise: expenses.reduce((sum, e) => sum + e.amountPaise, 0),
    byCategory: [...totals.entries()]
      .map(([category, totalPaise]) => ({ category, totalPaise }))
      .sort((a, b) => b.totalPaise - a.totalPaise),
  };
}

/** "Food ₹20, Travel ₹80" */
export function describeCategoryTotals(totals: CategoryTotal[]): string {
  return totals
    .map((t) => `${t.category} ${formatPaise(t.totalPaise)}`)
    .join(', ');
}

import { ObjectId } from 'mongodb';
import { tool } from 'langchain';
import { interrupt } from '@langchain/langgraph';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { Collections } from './db.ts';
import * as z from 'zod';
import {
  CATEGORIES,
  createExpenseService,
  describeCategoryTotals,
  isoDateSchema,
  summarize,
} from './services/expenses.ts';
import {
  createUserService,
  expenseFormatSchema,
  type ExpenseFormat,
} from './services/users.ts';
import { todayIn } from './dates.ts';
import { computeAnalysis, previousPeriod } from './services/analysis.ts';
import { createBudgetService } from './services/budget.ts';
import { formatPaise, paiseToRupees, rupeesToPaise } from './money.ts';
import type {
  BudgetResult,
  Channel,
  ExpensesAddedResult,
  ExpensesResult,
  FormatPickerInterrupt,
} from './types.ts';

export type ToolContext = { userId: string; channel: Channel };

/**
 * The user is always taken from the run config set by the server, never
 * from model output, so the LLM cannot act on another user's data.
 */
export function getToolContext(
  config: LangGraphRunnableConfig | undefined
): ToolContext {
  const userId = config?.configurable?.userId;
  const channel = config?.configurable?.channel ?? 'web';
  if (typeof userId !== 'string' || !ObjectId.isValid(userId)) {
    throw new Error('Missing authenticated user in run config');
  }
  return { userId, channel };
}

export const formatResumeSchema = z.union([
  z.object({ format: expenseFormatSchema }),
  z.object({ cancelled: z.literal(true) }),
]);

export type FormatDecision =
  | { kind: 'use'; format: ExpenseFormat }
  | { kind: 'ask' };

/**
 * A format the user names explicitly ("food ka table") always wins.
 * Otherwise the web asks once, then uses the saved preference.
 * Telegram cannot render charts or a picker, so it gets table or JSON.
 */
export function resolveFormat(
  saved: ExpenseFormat | null,
  channel: Channel,
  requested?: ExpenseFormat
): FormatDecision {
  const preferred = requested ?? saved;
  if (channel === 'telegram') {
    return { kind: 'use', format: preferred === 'json' ? 'json' : 'table' };
  }
  return preferred ? { kind: 'use', format: preferred } : { kind: 'ask' };
}

const rangeShape = {
  from: isoDateSchema.describe('Start date in YYYY-MM-DD format'),
  to: isoDateSchema.describe('End date in YYYY-MM-DD format'),
  categories: z
    .array(z.enum(CATEGORIES))
    .max(CATEGORIES.length)
    .optional()
    .describe(
      'Only include these categories, e.g. ["Food"] for "food ka chart" or ["Food", "Travel"]. Omit for all categories.'
    ),
};

export function initTools(collections: Collections, timeZone: string) {
  const expenseService = createExpenseService(collections);
  const userService = createUserService(collections);
  const budgetService = createBudgetService(collections, timeZone);

  /**
   * Add one or more expenses in a single call
   */
  const addExpenses = tool(
    async ({ items }, config): Promise<string> => {
      const { userId } = getToolContext(config);
      const today = todayIn(timeZone);

      const saved = await expenseService.addExpenses(
        userId,
        items.map((item) => ({
          title: item.title,
          category: item.category,
          amountPaise: rupeesToPaise(item.amount),
          spentOn: item.date ?? today,
        }))
      );

      const summary = summarize(saved, {
        from: saved[0].spentOn,
        to: saved.at(-1)!.spentOn,
      });

      const result: ExpensesAddedResult = {
        type: 'expenses_added',
        items: saved,
        totalPaise: summary.totalPaise,
        byCategory: summary.byCategory,
        summary: `${formatPaise(summary.totalPaise)} added (${describeCategoryTotals(summary.byCategory)})`,
      };
      // Warn once per month when spending first reaches 80% / 100% of the budget
      const budgetAlert = await budgetService.checkAfterSpend(userId);
      if (budgetAlert) result.budgetAlert = budgetAlert;
      return JSON.stringify(result);
    },
    {
      name: 'add_expenses',
      description:
        'Save one or more expenses. Use a single call for messages like "tea 20, taxi 80".',
      schema: z.object({
        items: z
          .array(
            z.object({
              title: z
                .string()
                .trim()
                .min(1)
                .max(120)
                .describe('Short description, e.g. "tea"'),
              amount: z
                .number()
                // Gemini rejects exclusiveMinimum, so use min() rather than positive()
                .min(0.01)
                .max(10_000_000)
                .describe('Amount in rupees, e.g. 20 or 149.5'),
              category: z.enum(CATEGORIES).describe('Best-fit category'),
              date: isoDateSchema
                .optional()
                .describe(
                  'YYYY-MM-DD, only if the user mentions a date; defaults to today'
                ),
            })
          )
          .min(1)
          .max(50),
      }),
    }
  );

  /**
   * Read expenses so the model can answer questions about them
   */
  const getExpenses = tool(
    async ({ from, to, categories }, config): Promise<string> => {
      const { userId } = getToolContext(config);
      const query = { from, to, categories };
      const expenses = await expenseService.listExpenses(userId, query);
      const summary = summarize(expenses, query);

      // Compact rows keep token usage low
      return JSON.stringify({
        type: 'expense_data',
        total: paiseToRupees(summary.totalPaise),
        byCategory: summary.byCategory.map((c) => [
          c.category,
          paiseToRupees(c.totalPaise),
        ]),
        rows: expenses.map((e) => [
          e.spentOn,
          e.title,
          e.category,
          paiseToRupees(e.amountPaise),
        ]),
      });
    },
    {
      name: 'get_expenses',
      description:
        'Get expense data for a date range to answer a question (totals, biggest spend, etc). Not for displaying a list to the user.',
      schema: z.object(rangeShape),
    }
  );

  /**
   * Display expenses to the user in their preferred format.
   * Pauses the run to ask for a format the first time (web only).
   */
  const showExpenses = tool(
    async ({ from, to, categories, format: requested }, config): Promise<string> => {
      const { userId, channel } = getToolContext(config);
      const query = { from, to, categories };
      const decision = resolveFormat(
        await userService.getExpenseFormat(userId),
        channel,
        requested
      );

      let format: ExpenseFormat;
      if (decision.kind === 'use') {
        format = decision.format;
      } else {
        const request: FormatPickerInterrupt = {
          kind: 'format_picker',
          from,
          to,
          categories: categories ?? [],
          options: ['table', 'json', 'chart'],
        };
        const answer = formatResumeSchema.parse(interrupt(request));

        if ('cancelled' in answer) {
          return JSON.stringify({ type: 'cancelled' });
        }
        format = answer.format;
        await userService.setExpenseFormat(userId, format);
      }

      const expenses = await expenseService.listExpenses(userId, query);
      const summary = summarize(expenses, query);

      const result: ExpensesResult = {
        type: 'expenses',
        format,
        expenses,
        summary,
      };
      return JSON.stringify(result);
    },
    {
      name: 'show_expenses',
      description:
        'Show the user their expenses for a date range as a table, JSON or daily chart. Use whenever the user wants to see, list or view expenses, including one or more categories.',
      schema: z.object({
        ...rangeShape,
        format: expenseFormatSchema
          .optional()
          .describe(
            'Only if the user explicitly asks for a table, JSON or chart; otherwise omit so their saved preference is used.'
          ),
      }),
    }
  );

  /**
   * Generate chart
   */
  const generateChart = tool(
    async ({ from, to, groupBy, categories }, config): Promise<string> => {
      const { userId } = getToolContext(config);
      const rows = await expenseService.aggregateByPeriod(
        userId,
        { from, to, categories },
        groupBy
      );

      return JSON.stringify({
        type: 'chart',
        data: rows.map((row) => ({
          [groupBy]: row.period,
          amount: paiseToRupees(row.totalPaise),
        })),
        labelKey: groupBy,
        categories: [...new Set(categories ?? [])],
      });
    },
    {
      name: 'generate_expense_chart',
      description:
        'Chart of expense totals grouped by week or month (optionally for some categories). Use when the user asks for a weekly/monthly chart or graph; for a simple chart of a list, use show_expenses with format "chart".',
      schema: z.object({
        ...rangeShape,
        groupBy: z
          .enum(['month', 'week', 'date'])
          .describe('How to group the data: by month, week or date.'),
      }),
    }
  );

  /**
   * Spending analysis for any period and any set of categories (or all).
   * Numbers are computed here; the model only writes the insights.
   */
  const analyzeExpenses = tool(
    async ({ from, to, categories }, config): Promise<string> => {
      const { userId } = getToolContext(config);
      const query = { from, to, categories };
      const [current, previous] = await Promise.all([
        expenseService.listExpenses(userId, query),
        expenseService.listExpenses(userId, { ...previousPeriod(from, to), categories }),
      ]);
      return JSON.stringify(computeAnalysis(current, previous, query));
    },
    {
      name: 'analyze_expenses',
      description:
        'Analyse spending for a date range: totals, averages, category shares, top expenses, biggest day, weekday pattern and change vs the previous period. Works for one category, several, or all (omit categories). Use for "analysis", "insights", "breakdown", "where is my money going", "compare", "trend".',
      schema: z.object(rangeShape),
    }
  );

  /**
   * Set, change or remove the monthly budget
   */
  const setBudget = tool(
    async ({ amount }, config): Promise<string> => {
      const { userId } = getToolContext(config);
      if (amount === 0) {
        await budgetService.clearBudget(userId);
        const result: BudgetResult = { type: 'budget', action: 'cleared', status: null };
        return JSON.stringify(result);
      }
      const status = await budgetService.setBudget(userId, rupeesToPaise(amount));
      const result: BudgetResult = { type: 'budget', action: 'set', status };
      return JSON.stringify(result);
    },
    {
      name: 'set_budget',
      description:
        'Set or change the user\'s monthly spending budget (e.g. "mera budget 20000 set karo"). Use amount 0 to remove the budget.',
      schema: z.object({
        amount: z
          .number()
          .min(0)
          .max(10_000_000)
          .describe('Monthly budget in rupees, e.g. 20000; 0 removes the budget'),
      }),
    }
  );

  /**
   * How much of this month's budget is used and left
   */
  const getBudgetStatus = tool(
    async (_input, config): Promise<string> => {
      const { userId } = getToolContext(config);
      const result: BudgetResult = {
        type: 'budget',
        action: 'status',
        status: await budgetService.getStatus(userId),
      };
      return JSON.stringify(result);
    },
    {
      name: 'get_budget_status',
      description:
        'Show the monthly budget: how much is spent, how much is left and the daily allowance (e.g. "budget kitna bacha?").',
      schema: z.object({}),
    }
  );

  return [addExpenses, getExpenses, showExpenses, generateChart, analyzeExpenses, setBudget, getBudgetStatus];
}

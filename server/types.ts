import type {
  CategoryTotal,
  Expense,
  ExpenseSummary,
} from './services/expenses.ts';
import type { ExpenseFormat } from './services/users.ts';
import type { BudgetAlert, BudgetStatus } from './services/budget.ts';

export type Channel = 'web' | 'telegram';

export type FormatPickerInterrupt = {
  kind: 'format_picker';
  from: string;
  to: string;
  categories: string[];
  options: ExpenseFormat[];
};

export type ExpensesResult = {
  type: 'expenses';
  format: ExpenseFormat;
  expenses: Expense[];
  summary: ExpenseSummary;
};

export type ExpensesAddedResult = {
  type: 'expenses_added';
  items: Expense[];
  totalPaise: number;
  byCategory: CategoryTotal[];
  summary: string;
  /** Set the first time this month's spending reaches 80% or 100% of the budget */
  budgetAlert?: BudgetAlert;
};

export type BudgetResult = {
  type: 'budget';
  action: 'set' | 'status' | 'cleared';
  /** null when no budget is set */
  status: BudgetStatus | null;
};

// Discriminated unions
export type StreamMessage =
  | {
      type: 'ai';
      payload: { text: string };
    }
  | {
      type: 'toolCall:start';
      payload: {
        name: string;
        args: Record<string, any>;
      };
    }
  | {
      type: 'tool';
      payload: {
        name: string;
        result: Record<string, any>;
      };
    }
  | {
      type: 'interrupt';
      payload: FormatPickerInterrupt;
    }
  | {
      // Replaces the AI text streamed so far (used when a reply goes off topic)
      type: 'ai:replace';
      payload: { text: string };
    }
  | {
      type: 'error';
      payload: { message: string };
    };

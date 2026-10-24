import type {
  CategoryTotal,
  Expense,
  ExpenseSummary,
} from './services/expenses.ts';
import type { ExpenseFormat } from './services/users.ts';

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
      type: 'error';
      payload: { message: string };
    };

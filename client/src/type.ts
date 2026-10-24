export type ExpenseFormat = 'table' | 'json' | 'chart';

export type User = { id: string; email: string; name: string };

export type Expense = {
  id: string;
  title: string;
  category: string;
  amountPaise: number;
  spentOn: string;
};

export type ExpenseSummary = {
  from: string;
  to: string;
  /** Categories the list was filtered to; empty means all */
  categories: string[];
  count: number;
  totalPaise: number;
  byCategory: { category: string; totalPaise: number }[];
};

export type FormatPickerRequest = {
  kind: 'format_picker';
  from: string;
  to: string;
  categories: string[];
  options: ExpenseFormat[];
};

/** Events as sent by the server over SSE. */
export type StreamEvent =
  | { type: 'ai'; payload: { text: string } }
  | {
      type: 'toolCall:start';
      payload: { name: string; args: Record<string, unknown> };
    }
  | {
      type: 'tool';
      // Tool results are dynamic JSON; components narrow on result.type
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: { name: string; result: Record<string, any> };
    }
  | { type: 'interrupt'; payload: FormatPickerRequest }
  | { type: 'error'; payload: { message: string } }
  // Replaces the AI text streamed so far (off-topic reply caught mid-stream)
  | { type: 'ai:replace'; payload: { text: string } };

export type StreamMessage =
  | (Exclude<StreamEvent, { type: 'interrupt' }> & { id: string })
  | {
      id: string;
      type: 'interrupt';
      payload: FormatPickerRequest;
      chosen?: ExpenseFormat;
      /** The user moved on without choosing; the server cancelled the question. */
      expired?: boolean;
    }
  | {
      id: string;
      type: 'user';
      payload: { text: string };
    };

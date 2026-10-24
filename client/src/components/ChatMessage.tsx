import { AlertTriangle, User, Wrench } from 'lucide-react';
import type { ExpenseFormat, StreamMessage } from '../type.ts';
import { ExpenseChart } from './ExpenseChart.tsx';
import { ExpenseView } from './ExpenseView.tsx';
import { AnalysisCard, type ExpenseAnalysis } from './AnalysisCard.tsx';
import { FormatPicker } from './FormatPicker.tsx';
import { Logo } from './Logo.tsx';
import { formatPaise } from '../lib/format.ts';

type Props = {
  message: StreamMessage;
  busy?: boolean;
  onPickFormat?: (messageId: string, format: ExpenseFormat) => void;
};

function ToolResultIcon() {
  return (
    <div className="w-8 h-8 rounded-lg bg-green-900/15 flex items-center justify-center">
      <svg className="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    </div>
  );
}

export function ChatMessage({ message, busy, onPickFormat }: Props) {
  if (message.type === 'user') {
    return (
      <div className="flex gap-4 py-6 px-6 transition-colors">
        <div className="shrink-0">
          <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center shadow-lg">
            <User color="white" className="w-5 h-5" />
          </div>
        </div>
        <div className="flex-1 space-y-2 overflow-hidden">
          <div className="text-sm font-medium text-zinc-300">You</div>
          <div className="text-zinc-100 whitespace-pre-wrap wrap-break-word leading-7">
            {message.payload.text}
          </div>
        </div>
      </div>
    );
  } else if (message.type === 'ai') {
    return (
      <div className="flex gap-4 py-6 px-6 transition-colors">
        <div className="shrink-0">
          <Logo size="sm" />
        </div>
        <div className="flex-1 space-y-2 overflow-hidden">
          <div className="text-sm font-medium text-zinc-300">Hisaab.ai</div>
          <div className="text-zinc-100 whitespace-pre-wrap wrap-break-word leading-7">
            {message.payload.text}
          </div>
        </div>
      </div>
    );
  } else if (message.type === 'toolCall:start') {
    return (
      <div className="flex gap-4 py-4 px-6">
        <div className="shrink-0">
          <div className="w-8 h-8 rounded-lg bg-zinc-700 flex items-center justify-center">
            <Wrench color="gray" className="w-4 h-4" />
          </div>
        </div>
        <div className="flex-1 space-y-2">
          <div className="text-sm text-zinc-400 italic">
            Using tool:{' '}
            <span className="text-purple-400 font-medium">{message.payload.name}</span>
          </div>
          <div className="text-xs text-zinc-300 bg-purple-900/15 rounded-lg p-3 font-mono whitespace-pre-wrap">
            {JSON.stringify(message.payload.args, null, 2)}
          </div>
        </div>
      </div>
    );
  } else if (message.type === 'interrupt') {
    return (
      <FormatPicker
        request={message.payload}
        chosen={message.chosen}
        expired={message.expired}
        disabled={busy}
        onPick={(format) => onPickFormat?.(message.id, format)}
      />
    );
  } else if (message.type === 'error') {
    return (
      <div className="flex gap-4 py-4 px-6">
        <div className="shrink-0">
          <div className="w-8 h-8 rounded-lg bg-red-900/20 flex items-center justify-center">
            <AlertTriangle className="w-4 h-4 text-red-400" />
          </div>
        </div>
        <div role="alert" className="flex-1 text-sm text-red-300 pt-1.5">
          {message.payload.message}
        </div>
      </div>
    );
  } else if (message.type === 'tool') {
    const { name, result } = message.payload;

    if (result.type === 'cancelled') return null;

    // Generative UI for expense lists
    if (result.type === 'expenses') {
      return (
        <div className="flex gap-4 py-4 px-6">
          <div className="shrink-0">
            <ToolResultIcon />
          </div>
          <div className="flex-1 min-w-0">
            <ExpenseView format={result.format} expenses={result.expenses} summary={result.summary} />
          </div>
        </div>
      );
    }

    if (result.type === 'analysis') {
      return (
        <div className="flex gap-4 py-4 px-6">
          <div className="shrink-0">
            <ToolResultIcon />
          </div>
          <div className="flex-1 min-w-0">
            <AnalysisCard analysis={result as ExpenseAnalysis} />
          </div>
        </div>
      );
    }

    if (result.type === 'expenses_added') {
      return (
        <div className="flex gap-4 py-4 px-6">
          <div className="shrink-0">
            <ToolResultIcon />
          </div>
          <div className="flex-1 max-w-md rounded-xl border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800">
            {result.items.map((item: { id: string; title: string; category: string; amountPaise: number }) => (
              <div key={item.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="text-zinc-200">
                  {item.title} <span className="text-xs text-zinc-500">· {item.category}</span>
                </span>
                <span className="text-zinc-100 tabular-nums">{formatPaise(item.amountPaise)}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="flex gap-4 py-4 px-6">
        <div className="shrink-0">
          <ToolResultIcon />
        </div>
        <div className="flex-1 space-y-2">
          <div className="text-sm text-zinc-400">
            Tool result: <span className="text-green-400 font-medium">{name}</span>
            {result.categories?.length > 0 && (
              <span className="ml-2 px-2 py-0.5 rounded-full text-xs bg-zinc-800 text-purple-300">
                {result.categories.join(' & ')}
              </span>
            )}
          </div>
          {name === 'generate_expense_chart' ? (
            <ExpenseChart chartData={result.data} labelKey={result.labelKey} />
          ) : (
            <div className="text-xs text-zinc-300 bg-green-900/20 rounded-lg p-3 font-mono whitespace-pre-wrap">
              {JSON.stringify(result, null, 2)}
            </div>
          )}
        </div>
      </div>
    );
  }
}

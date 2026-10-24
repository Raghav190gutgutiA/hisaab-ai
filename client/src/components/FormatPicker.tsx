import type { ExpenseFormat, FormatPickerRequest } from '../type.ts';
import { formatDate } from '../lib/format.ts';
import { FORMAT_OPTIONS } from '../lib/formatOptions.ts';

type Props = {
  request: FormatPickerRequest;
  chosen?: ExpenseFormat;
  expired?: boolean;
  disabled?: boolean;
  onPick: (format: ExpenseFormat) => void;
};

/**
 * Shown when the agent pauses to ask how expenses should be displayed.
 * The choice resumes the run and is saved as the user's preference.
 */
export function FormatPicker({ request, chosen, expired, disabled, onPick }: Props) {
  const locked = Boolean(chosen) || expired || disabled;

  return (
    <div className="flex gap-4 py-4 px-6">
      <div className="shrink-0 w-8" />
      <div className="flex-1 space-y-3">
        <div className="text-sm text-zinc-300">
          How would you like to see your{' '}
          {request.categories.length > 0 && (
            <span className="text-zinc-100 font-medium">{request.categories.join(' & ')} </span>
          )}
          expenses for{' '}
          <span className="text-zinc-100 font-medium">
            {formatDate(request.from)} – {formatDate(request.to)}
          </span>
          ?
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-xl">
          {FORMAT_OPTIONS.filter((o) => request.options.includes(o.value)).map(
            ({ value, label, description, Icon }) => {
              const isChosen = chosen === value;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={locked}
                  onClick={() => onPick(value)}
                  className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                    isChosen
                      ? 'border-purple-500 bg-purple-500/10'
                      : 'border-zinc-700/50 bg-zinc-800/40 enabled:hover:border-purple-500/50'
                  } disabled:cursor-default ${locked && !isChosen ? 'opacity-40' : ''}`}>
                  <Icon className="w-5 h-5 text-purple-400 shrink-0" />
                  <div>
                    <div className="text-sm font-medium text-zinc-200">{label}</div>
                    <div className="text-xs text-zinc-500">{description}</div>
                  </div>
                </button>
              );
            }
          )}
        </div>
        <p className="text-xs text-zinc-500">
          {chosen
            ? 'Saved as your default. You can switch anytime from the result.'
            : expired
              ? 'Skipped. Ask again anytime.'
              : "I'll remember your choice for next time."}
        </p>
      </div>
    </div>
  );
}

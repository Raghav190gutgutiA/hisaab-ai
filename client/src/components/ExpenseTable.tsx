import { useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { Expense } from '../type.ts';
import { formatDate, formatPaise } from '../lib/format.ts';

type SortKey = 'spentOn' | 'title' | 'category' | 'amountPaise';

const COLUMNS: { key: SortKey; label: string; align?: 'right' }[] = [
  { key: 'spentOn', label: 'Date' },
  { key: 'title', label: 'Description' },
  { key: 'category', label: 'Category' },
  { key: 'amountPaise', label: 'Amount', align: 'right' },
];

export function ExpenseTable({
  expenses,
  totalPaise,
}: {
  expenses: Expense[];
  totalPaise: number;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'spentOn',
    dir: 'asc',
  });

  const sorted = [...expenses].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  function toggle(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'amountPaise' ? 'desc' : 'asc' }
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-400">
            {COLUMNS.map(({ key, label, align }) => {
              const active = sort.key === key;
              const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
              return (
                <th
                  key={key}
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={`px-4 py-3 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    className={`inline-flex items-center gap-1 hover:text-zinc-100 ${active ? 'text-zinc-100' : ''}`}>
                    {label}
                    <Icon className="w-3.5 h-3.5" />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => (
            <tr key={e.id} className="border-b border-zinc-800/60 last:border-0 text-zinc-200">
              <td className="px-4 py-2.5 whitespace-nowrap text-zinc-400">{formatDate(e.spentOn)}</td>
              <td className="px-4 py-2.5">{e.title}</td>
              <td className="px-4 py-2.5">
                <span className="px-2 py-0.5 rounded-full text-xs bg-zinc-800 text-zinc-300">
                  {e.category}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{formatPaise(e.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-zinc-700 text-zinc-100 font-medium">
            <td className="px-4 py-3" colSpan={3}>Total</td>
            <td className="px-4 py-3 text-right tabular-nums">{formatPaise(totalPaise)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

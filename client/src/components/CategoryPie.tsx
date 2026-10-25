import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { formatPaise } from '../lib/format.ts';

/**
 * Fixed colour per category, so a category looks the same in every chart
 * (colour follows the entity, never its rank). These are the dataviz
 * reference palette's 8 dark-mode slots in their validated order, checked
 * against the card surface (#18181b) with the palette validator: every
 * adjacent pair clears the colour-blind and normal-vision floors and all
 * reach 3:1 contrast. Categories past the eighth fold into a neutral "Other".
 */
const CATEGORY_COLORS: Record<string, string> = {
  Food: '#3987e5',
  Travel: '#d95926',
  Shopping: '#199e70',
  Groceries: '#c98500',
  Bills: '#d55181',
  Entertainment: '#008300',
  Rent: '#9085e9',
  Health: '#e66767',
};
const OTHER_COLOR = '#71717a';
const SLOT_ORDER = Object.keys(CATEGORY_COLORS);
const SURFACE = '#18181b';

type Slice = { name: string; totalPaise: number; color: string; pct: number };

/** Slices in the palette's validated order, so neighbouring colours stay distinct. */
function toSlices(byCategory: { category: string; totalPaise: number }[]): Slice[] {
  const total = byCategory.reduce((sum, c) => sum + c.totalPaise, 0) || 1;
  const known = SLOT_ORDER.flatMap((name) => byCategory.filter((c) => c.category === name)).map((c) => ({
    name: c.category,
    totalPaise: c.totalPaise,
    color: CATEGORY_COLORS[c.category],
  }));
  const otherPaise = byCategory
    .filter((c) => !(c.category in CATEGORY_COLORS))
    .reduce((sum, c) => sum + c.totalPaise, 0);
  const slices = otherPaise > 0 ? [...known, { name: 'Other', totalPaise: otherPaise, color: OTHER_COLOR }] : known;
  return slices.map((s) => ({ ...s, pct: Math.round((s.totalPaise / total) * 1000) / 10 }));
}

function SliceTooltip({ active, payload }: { active?: boolean; payload?: { payload: Slice }[] }) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs shadow-lg">
      <div className="flex items-center gap-2 text-zinc-100">
        <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
        {s.name}
      </div>
      <div className="mt-0.5 text-zinc-400 tabular-nums">
        {formatPaise(s.totalPaise)} · {s.pct}%
      </div>
    </div>
  );
}

/** Donut of spending by category, with a labelled legend (name, amount, share). */
export function CategoryPie({ byCategory }: { byCategory: { category: string; totalPaise: number }[] }) {
  const slices = toSlices(byCategory);

  return (
    <div className="rounded-xl bg-zinc-900 p-4 grid gap-4 sm:grid-cols-[minmax(0,220px)_1fr] items-center">
      <div className="h-[200px]" role="img" aria-label="Pie chart of spending by category">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="totalPaise"
              nameKey="name"
              innerRadius="55%"
              outerRadius="95%"
              startAngle={90}
              endAngle={-270}
              stroke={SURFACE}
              strokeWidth={2}
              isAnimationActive={false}>
              {slices.map((s) => (
                <Cell key={s.name} fill={s.color} />
              ))}
            </Pie>
            <Tooltip content={<SliceTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Legend doubles as direct labels, so colour is never the only cue */}
      <ul className="space-y-1.5 text-sm">
        {slices.map((s) => (
          <li key={s.name} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 min-w-0">
              <span className="inline-block w-3 h-3 rounded-sm shrink-0" style={{ background: s.color }} aria-hidden />
              <span className="text-zinc-200 truncate">{s.name}</span>
            </span>
            <span className="text-zinc-400 tabular-nums shrink-0">
              {formatPaise(s.totalPaise)} <span className="text-zinc-500">· {s.pct}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

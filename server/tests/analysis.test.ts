import { describe, expect, it } from 'vitest';
import { computeAnalysis, daysInRange, previousPeriod } from '../services/analysis.ts';
import { describeAnalysis } from '../telegram/format.ts';
import { buildTurnReplies } from '../telegram/bot.ts';
import type { Expense } from '../services/expenses.ts';

const e = (title: string, category: Expense['category'], rupees: number, spentOn: string): Expense => ({
  id: title,
  title,
  category,
  amountPaise: rupees * 100,
  spentOn,
});

const october = [
  e('lunch', 'Food', 150, '2026-10-05'), // a Monday
  e('dinner', 'Food', 250, '2026-10-05'),
  e('cab', 'Travel', 300, '2026-10-06'),
  e('rent', 'Rent', 1500, '2026-10-01'),
];
const september = [e('rent', 'Rent', 1500, '2026-09-01'), e('lunch', 'Food', 500, '2026-09-10')];

describe('period helpers', () => {
  it('counts days inclusively and finds the previous equal period', () => {
    expect(daysInRange('2026-10-01', '2026-10-31')).toBe(31);
    expect(previousPeriod('2026-10-01', '2026-10-31')).toEqual({ from: '2026-08-31', to: '2026-09-30' });
    expect(previousPeriod('2026-10-25', '2026-10-25')).toEqual({ from: '2026-10-24', to: '2026-10-24' });
  });
});

describe('computeAnalysis', () => {
  const query = { from: '2026-10-01', to: '2026-10-31' };

  it('computes totals, averages, shares and comparison in integer paise', () => {
    const a = computeAnalysis(october, september, query);
    expect(a).toMatchObject({
      type: 'analysis',
      days: 31,
      count: 4,
      totalPaise: 220000,
      avgPerDayPaise: Math.round(220000 / 31),
      avgPerExpensePaise: 55000,
      biggestDay: { date: '2026-10-01', totalPaise: 150000 },
      previous: { totalPaise: 200000, count: 2, changePct: 10 },
    });
    expect(a.byCategory).toEqual([
      { category: 'Rent', totalPaise: 150000, count: 1, sharePct: 68.2 },
      { category: 'Food', totalPaise: 40000, count: 2, sharePct: 18.2 },
      { category: 'Travel', totalPaise: 30000, count: 1, sharePct: 13.6 },
    ]);
    expect(a.topExpenses.map((t) => t.title)).toEqual(['rent', 'cab', 'dinner', 'lunch']);
    expect(a.byWeekday.find((d) => d.day === 'Mon')!.totalPaise).toBe(40000);
    expect(Number.isInteger(a.avgPerDayPaise)).toBe(true);
  });

  it('records the analysed categories and handles empty periods', () => {
    const a = computeAnalysis([], [], { ...query, categories: ['Food', 'Food', 'Travel'] });
    expect(a).toMatchObject({ categories: ['Food', 'Travel'], count: 0, totalPaise: 0, biggestDay: null });
    expect(a.previous.changePct).toBeNull();
  });
});

describe('Telegram analysis', () => {
  const analysis = computeAnalysis(october, september, { from: '2026-10-01', to: '2026-10-31' });

  it('describes the analysis in English sentences', () => {
    const text = describeAnalysis(analysis, 'english');
    expect(text).toBe(
      'Between 01 Oct – 31 Oct you spent <b>₹2,200</b> across 4 expenses, about ₹70.97 a day. ' +
        "That's 10% more than the previous period (₹2,000). " +
        'By category: Rent 68.2% (₹1,500), Food 18.2% (₹400) and Travel 13.6% (₹300). ' +
        'Your biggest single expense was rent ₹1,500 (01 Oct).'
    );
    expect(text).not.toMatch(/<pre>|█/);
  });

  it('describes the analysis in Hinglish', () => {
    const text = describeAnalysis(analysis, 'hinglish');
    expect(text).toContain('01 Oct – 31 Oct mein aapne <b>₹2,200</b> kharch kiye');
    expect(text).toContain('pichle period (₹2,000) se 10% zyada hai');
    expect(text).toContain('Rent 68.2% (₹1,500), Food 18.2% (₹400) aur Travel 13.6% (₹300)');
  });

  it('sends the stats followed by the model insights', () => {
    const replies = buildTurnReplies(
      [
        { type: 'human', text: 'analyse this month' },
        { type: 'tool', text: JSON.stringify(analysis) },
        { type: 'ai', text: '- Rent is 68% of your spending.' },
      ],
      'http://localhost:5173'
    );
    expect(replies).toHaveLength(2);
    expect(replies[1]).toBe('- Rent is 68% of your spending.');
  });
});

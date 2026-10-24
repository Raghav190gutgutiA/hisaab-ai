import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Context } from 'grammy';
import {
  describeExpenses,
  escapeHtml,
  formatAddedConfirmation,
} from '../telegram/format.ts';
import {
  buildTurnReplies,
  dedupeUpdates,
  verifyTelegramSecret,
} from '../telegram/bot.ts';
import { summarize, type Expense } from '../services/expenses.ts';
import type { Database } from '../db.ts';
import { startTestDatabase } from './helpers.ts';

const range = { from: '2026-10-01', to: '2026-10-31' };
const expenses: Expense[] = [
  { id: '1', title: 'tea', category: 'Food', amountPaise: 2000, spentOn: '2026-10-25' },
  { id: '2', title: 'taxi <fast>', category: 'Travel', amountPaise: 8000, spentOn: '2026-10-25' },
];
const URL = 'http://localhost:5173';

describe('Telegram replies are natural language', () => {
  it('builds the logging confirmation from tool results', () => {
    const summary = summarize(expenses, range);
    expect(
      formatAddedConfirmation({
        type: 'expenses_added',
        items: expenses,
        totalPaise: summary.totalPaise,
        byCategory: summary.byCategory,
        summary: '',
      })
    ).toBe('✅ ₹100 added (Travel ₹80, Food ₹20)');
  });

  it('describes a list in English sentences, with no table or JSON', () => {
    const text = describeExpenses(expenses, summarize(expenses, range), 'english', URL);
    expect(text).toContain('You spent <b>₹100</b> between 01 Oct – 31 Oct, across 2 expenses: Travel ₹80, Food ₹20.');
    expect(text).toContain('Your biggest spend was taxi &lt;fast&gt; at ₹80 on 25 Oct.');
    expect(text).toContain('They were: taxi &lt;fast&gt; ₹80 (25 Oct), tea ₹20 (25 Oct).');
    expect(text).toContain(`open the web dashboard: ${URL}`);
    expect(text).not.toMatch(/<pre>|<code>|\{|\|/);
  });

  it('describes a list in Hinglish when the user wrote Hinglish', () => {
    const text = describeExpenses(expenses, summarize(expenses, range), 'hinglish', URL);
    expect(text).toContain('01 Oct – 31 Oct mein aapne <b>₹100</b> kharch kiye, 2 expenses mein');
    expect(text).toContain('Sabse bada kharcha taxi &lt;fast&gt; ₹80 (25 Oct) tha.');
  });

  it('names the categories and handles empty lists', () => {
    const food = expenses.filter((e) => e.category === 'Food');
    const query = { ...range, categories: ['Food' as const] };
    expect(describeExpenses(food, summarize(food, query), 'english', URL)).toContain('You spent <b>₹20</b> on Food');
    expect(describeExpenses([], summarize([], query), 'english', URL)).toBe('No Food expenses between 01 Oct – 31 Oct.');
    expect(describeExpenses([], summarize([], query), 'hinglish', URL)).toBe(
      '01 Oct – 31 Oct ke beech Food ka koi expense nahi mila.'
    );
  });

  it('summarises long lists instead of listing everything', () => {
    const many: Expense[] = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      title: `item ${i}`,
      category: 'Food',
      amountPaise: 100 * (i + 1),
      spentOn: '2026-10-25',
    }));
    const text = describeExpenses(many, summarize(many, range), 'english', URL);
    expect(text).toContain('and 22 more');
    expect(text.length).toBeLessThan(4096);
  });

  it('turns a JSON or table request into sentences too', () => {
    const summary = summarize(expenses, range);
    const replies = buildTurnReplies(
      [
        { type: 'human', text: 'show this month as json' },
        { type: 'tool', text: JSON.stringify({ type: 'expenses', format: 'json', expenses, summary }) },
        { type: 'ai', text: 'Here are your expenses.' },
      ],
      URL
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('You spent <b>₹100</b>');
  });

  it('confirms in Hinglish when the user wrote Hinglish', () => {
    const summary = summarize(expenses, range);
    const replies = buildTurnReplies(
      [
        { type: 'human', text: 'aaj chai 20 aur auto 80 hua' },
        {
          type: 'tool',
          text: JSON.stringify({ type: 'expenses_added', totalPaise: 10000, byCategory: summary.byCategory }),
        },
      ],
      URL
    );
    expect(replies).toEqual(['✅ ₹100 add ho gaya (Travel ₹80, Food ₹20)']);
  });

  it('falls back to escaped model text when no tool ran', () => {
    expect(buildTurnReplies([{ type: 'ai', text: 'How much was it? <amount>' }], 'x')).toEqual([
      'How much was it? &lt;amount&gt;',
    ]);
  });

  it('escapes HTML special characters', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('Telegram update dedupe', () => {
  let database: Database;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ database, stop } = await startTestDatabase());
  });
  afterAll(() => stop());

  it('processes an update_id once, even when Telegram retries it', async () => {
    const middleware = dedupeUpdates(database.collections.telegramUpdates);
    let handled = 0;
    const ctx = { update: { update_id: 4242 } } as Context;
    const next = async () => {
      handled++;
    };

    await middleware(ctx, next);
    await middleware(ctx, next);
    await Promise.all([middleware(ctx, next), middleware(ctx, next)]);
    expect(handled).toBe(1);

    await middleware({ update: { update_id: 4243 } } as Context, next);
    expect(handled).toBe(2);
  });
});

describe('webhook secret verification', () => {
  const app = express();
  app.post('/hook', verifyTelegramSecret('s3cret-token'), (_req, res) => {
    res.json({ ok: true });
  });

  it('accepts requests with the right secret header', async () => {
    await request(app).post('/hook').set('X-Telegram-Bot-Api-Secret-Token', 's3cret-token').expect(200);
  });

  it('rejects a missing or wrong secret', async () => {
    await request(app).post('/hook').expect(401);
    await request(app).post('/hook').set('X-Telegram-Bot-Api-Secret-Token', 's3cret-tokeX').expect(401);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createExpenseService } from '../services/expenses.ts';
import { createBudgetService } from '../services/budget.ts';
import { createRemovalService, MAX_REMOVAL_MATCHES } from '../services/removal.ts';
import { initTools } from '../tools.ts';
import { buildTurnReplies } from '../telegram/bot.ts';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { signToken } from '../auth.ts';
import { todayIn } from '../dates.ts';
import type { Database } from '../db.ts';
import { createTestUser, startTestDatabase } from './helpers.ts';

const TZ = 'Asia/Kolkata';
let database: Database;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ database, stop } = await startTestDatabase());
});
afterAll(() => stop());

const services = () => {
  const expenses = createExpenseService(database.collections);
  const budget = createBudgetService(database.collections, TZ);
  return { expenses, budget, removal: createRemovalService(database.collections, expenses, budget) };
};

async function seed(userId: string) {
  const { expenses } = services();
  const today = todayIn(TZ);
  // Logged one after another so "latest" has a clear order
  for (const [title, category, rupees, spentOn] of [
    ['taxi', 'Travel', 80, '2026-10-20'],
    ['tea', 'Food', 20, today],
    ['taxi', 'Travel', 120, today],
  ] as const) {
    await expenses.addExpenses(userId, [{ title, category, amountPaise: rupees * 100, spentOn }]);
  }
}

describe('finding expenses to delete', () => {
  it('matches by title and date, newest first, without deleting anything', async () => {
    const userId = await createTestUser(database, 'find@example.com');
    await seed(userId);
    const { removal, expenses } = services();

    const today = todayIn(TZ);
    const preview = await removal.preview(userId, { title: 'TAXI', from: today, to: today });
    expect(preview.matches.map((e) => [e.title, e.amountPaise])).toEqual([['taxi', 12000]]);
    expect(preview.token).toMatch(/^[A-Za-z0-9_-]{12}$/);

    const all = await expenses.listExpenses(userId, { from: '2026-01-01', to: '2099-12-31' });
    expect(all).toHaveLength(3);
  });

  it('"latest" picks the most recently logged expense', async () => {
    const userId = await createTestUser(database, 'latest@example.com');
    await seed(userId);
    const preview = await services().removal.preview(userId, { latest: 1 });
    expect(preview.matches.map((e) => e.amountPaise)).toEqual([12000]);
  });

  it('matches by amount and category, and treats regex characters literally', async () => {
    const userId = await createTestUser(database, 'amount@example.com');
    await seed(userId);
    const { removal } = services();
    expect((await removal.preview(userId, { amountPaise: 8000 })).matches).toHaveLength(1);
    expect((await removal.preview(userId, { category: 'Travel' })).matches).toHaveLength(2);
    expect((await removal.preview(userId, { title: '.*' })).matches).toHaveLength(0);
  });

  it('never finds another user\'s expenses', async () => {
    const owner = await createTestUser(database, 'owner@example.com');
    const other = await createTestUser(database, 'other@example.com');
    await seed(owner);
    const preview = await services().removal.preview(other, { title: 'taxi' });
    expect(preview).toMatchObject({ matches: [], token: null });
  });

  it('refuses requests that match too much', async () => {
    const userId = await createTestUser(database, 'many@example.com');
    const items = Array.from({ length: MAX_REMOVAL_MATCHES + 1 }, (_, i) => ({
      title: `snack ${i}`,
      category: 'Food' as const,
      amountPaise: 1000,
      spentOn: todayIn(TZ),
    }));
    await services().expenses.addExpenses(userId, items);
    const preview = await services().removal.preview(userId, { category: 'Food' });
    expect(preview).toMatchObject({ tooMany: true, token: null });
  });

  it('requires at least one condition', async () => {
    const userId = await createTestUser(database, 'empty@example.com');
    await expect(services().removal.preview(userId, {})).rejects.toThrow();
  });
});

describe('confirming a delete', () => {
  it('deletes on confirm, and the token works only once', async () => {
    const userId = await createTestUser(database, 'confirm@example.com');
    await seed(userId);
    const { removal, expenses } = services();
    const { token } = await removal.preview(userId, { title: 'taxi' });

    const first = await removal.confirm(userId, token!);
    expect(first).toMatchObject({ ok: true, totalPaise: 20000 });
    expect(await removal.confirm(userId, token!)).toEqual({ ok: false, reason: 'expired' });

    const left = await expenses.listExpenses(userId, { from: '2026-01-01', to: '2099-12-31' });
    expect(left.map((e) => e.title)).toEqual(['tea']);
  });

  it('ignores another user\'s token', async () => {
    const owner = await createTestUser(database, 'tok-owner@example.com');
    const intruder = await createTestUser(database, 'tok-intruder@example.com');
    await seed(owner);
    const { removal, expenses } = services();
    const { token } = await removal.preview(owner, { latest: 1 });

    expect(await removal.confirm(intruder, token!)).toEqual({ ok: false, reason: 'expired' });
    expect(await expenses.listExpenses(owner, { from: '2026-01-01', to: '2099-12-31' })).toHaveLength(3);
  });

  it('cancel discards the request', async () => {
    const userId = await createTestUser(database, 'cancel-del@example.com');
    await seed(userId);
    const { removal } = services();
    const { token } = await removal.preview(userId, { latest: 1 });
    await removal.cancel(userId, token!);
    expect(await removal.confirm(userId, token!)).toEqual({ ok: false, reason: 'expired' });
  });

  it('re-arms budget alerts when spending drops back under a threshold', async () => {
    const userId = await createTestUser(database, 'rearm@example.com');
    const { budget, removal, expenses } = services();
    await budget.setBudget(userId, 100_000); // ₹1,000
    await expenses.addExpenses(userId, [
      { title: 'pizza', category: 'Food', amountPaise: 85_000, spentOn: todayIn(TZ) },
    ]);
    expect((await budget.checkAfterSpend(userId))?.level).toBe(80);

    const { token } = await removal.preview(userId, { title: 'pizza' });
    await removal.confirm(userId, token!);
    await expenses.addExpenses(userId, [
      { title: 'dinner', category: 'Food', amountPaise: 90_000, spentOn: todayIn(TZ) },
    ]);
    expect((await budget.checkAfterSpend(userId))?.level).toBe(80);
  });
});

describe('delete_expenses tool and replies', () => {
  it('returns a preview with a token and deletes nothing', async () => {
    const userId = await createTestUser(database, 'tool-del@example.com');
    await seed(userId);
    const tool = initTools(database.collections, TZ).find((t) => t.name === 'delete_expenses')!;
    const raw = await (tool as unknown as { invoke: (i: unknown, c: unknown) => Promise<string> }).invoke(
      { title: 'tea' },
      { configurable: { userId, channel: 'web' } }
    );
    const result = JSON.parse(raw);
    expect(result).toMatchObject({ type: 'delete_preview', totalPaise: 2000, tooMany: false });
    expect(result.matches).toHaveLength(1);
    expect(await services().expenses.listExpenses(userId, { from: '2026-01-01', to: '2099-12-31' })).toHaveLength(3);
  });

  it('Telegram shows Delete / Cancel buttons within the 64-byte limit', () => {
    const replies = buildTurnReplies(
      [
        { type: 'human', text: 'last expense hata do' },
        {
          type: 'tool',
          text: JSON.stringify({
            type: 'delete_preview',
            matches: [{ id: '1', title: 'taxi', category: 'Travel', amountPaise: 12000, spentOn: '2026-10-25' }],
            totalPaise: 12000,
            token: 'AbCdEfGhIjKl',
            tooMany: false,
          }),
        },
      ],
      'https://app.example'
    );
    const reply = replies[0] as { text: string; buttons: { callback_data: string }[][] };
    expect(reply.text).toBe('1 expense mile: taxi ₹120 (25 Oct). Delete karne ke liye neeche button dabayein.');
    expect(reply.buttons[0].map((b) => b.callback_data)).toEqual(['del:y:h:AbCdEfGhIjKl', 'del:n:h:AbCdEfGhIjKl']);
    for (const b of reply.buttons[0]) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });
});

describe('delete REST endpoints', () => {
  it('confirms a chat delete and deletes a single expense from the table', async () => {
    const config = loadConfig({ JWT_SECRET: 'test-secret' });
    const app = createApp({
      config,
      database,
      getAgent: () => {
        throw new Error('not needed');
      },
      bot: null,
    });
    const userId = await createTestUser(database, 'rest-del@example.com');
    const other = await createTestUser(database, 'rest-other@example.com');
    await seed(userId);
    const auth = { Authorization: `Bearer ${signToken(userId, config)}` };
    const otherAuth = { Authorization: `Bearer ${signToken(other, config)}` };

    const { token, matches } = await services().removal.preview(userId, { title: 'tea' });
    await request(app).post('/expenses/delete/confirm').set(otherAuth).send({ token }).expect(410);
    const confirmed = await request(app).post('/expenses/delete/confirm').set(auth).send({ token }).expect(200);
    expect(confirmed.body.deleted).toHaveLength(1);
    await request(app).post('/expenses/delete/confirm').set(auth).send({ token }).expect(410);
    expect(matches[0].title).toBe('tea');

    const [taxi] = (await services().removal.preview(userId, { latest: 1 })).matches;
    await request(app).delete(`/expenses/${taxi.id}`).set(otherAuth).expect(404);
    await request(app).delete(`/expenses/${taxi.id}`).set(auth).expect(200);
    await request(app).delete(`/expenses/${taxi.id}`).set(auth).expect(404);
    await request(app).delete('/expenses/not-an-id').set(auth).expect(400);
    await request(app).delete(`/expenses/${taxi.id}`).expect(401);
  });
});

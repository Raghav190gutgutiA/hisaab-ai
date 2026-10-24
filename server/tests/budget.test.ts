import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createBudgetService, reachedLevel } from '../services/budget.ts';
import { createExpenseService } from '../services/expenses.ts';
import { initTools } from '../tools.ts';
import { budgetAlertText, budgetStatusText } from '../language.ts';
import { buildTurnReplies } from '../telegram/bot.ts';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { signToken } from '../auth.ts';
import { monthRange, todayIn } from '../dates.ts';
import type { Database } from '../db.ts';
import { createTestUser, startTestDatabase } from './helpers.ts';

const TZ = 'Asia/Kolkata';
let database: Database;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ database, stop } = await startTestDatabase());
});
afterAll(() => stop());

const today = () => todayIn(TZ);

async function spend(userId: string, items: [string, string, number][]) {
  await createExpenseService(database.collections).addExpenses(
    userId,
    items.map(([title, category, rupees]) => ({
      title,
      category: category as never,
      amountPaise: rupees * 100,
      spentOn: today(),
    }))
  );
}

describe('reachedLevel', () => {
  it('maps usage to the alert thresholds', () => {
    expect(reachedLevel(79.9)).toBeNull();
    expect(reachedLevel(80)).toBe(80);
    expect(reachedLevel(99.9)).toBe(80);
    expect(reachedLevel(100)).toBe(100);
    expect(reachedLevel(140)).toBe(100);
  });
});

describe('budget status', () => {
  it('computes spent, left, daily allowance and the biggest flexible category', async () => {
    const userId = await createTestUser(database, 'status@example.com');
    const budget = createBudgetService(database.collections, TZ);
    expect(await budget.getStatus(userId)).toBeNull();

    await spend(userId, [
      ['rent', 'Rent', 12000],
      ['dinner', 'Food', 3000],
      ['cab', 'Travel', 1000],
    ]);
    const status = await budget.setBudget(userId, 2_000_000); // ₹20,000

    const { to } = monthRange(TZ);
    const daysLeft = Number(to.slice(8)) - Number(today().slice(8)) + 1;
    expect(status).toMatchObject({
      month: today().slice(0, 7),
      budgetPaise: 2_000_000,
      spentPaise: 1_600_000,
      remainingPaise: 400_000,
      usedPct: 80,
      daysLeft,
      dailyAllowancePaise: Math.floor(400_000 / daysLeft),
      // Rent is bigger but fixed, so the tip points at Food
      topFlexible: { category: 'Food', totalPaise: 300_000 },
    });
  });

  it('removes a budget', async () => {
    const userId = await createTestUser(database, 'clear@example.com');
    const budget = createBudgetService(database.collections, TZ);
    await budget.setBudget(userId, 100_000);
    await budget.clearBudget(userId);
    expect(await budget.getStatus(userId)).toBeNull();
  });

  it('rejects invalid budgets', async () => {
    const userId = await createTestUser(database, 'invalid@example.com');
    const budget = createBudgetService(database.collections, TZ);
    await expect(budget.setBudget(userId, 50)).rejects.toThrow();
    await expect(budget.setBudget(userId, 12.5)).rejects.toThrow();
  });
});

describe('budget alerts', () => {
  it('warns once at 80%, once at 100%, then stays quiet for the month', async () => {
    const userId = await createTestUser(database, 'alerts@example.com');
    const budget = createBudgetService(database.collections, TZ);
    await budget.setBudget(userId, 1_000_000); // ₹10,000

    await spend(userId, [['groceries', 'Groceries', 7000]]);
    expect(await budget.checkAfterSpend(userId)).toBeNull(); // 70%

    await spend(userId, [['shoes', 'Shopping', 1500]]);
    expect((await budget.checkAfterSpend(userId))?.level).toBe(80); // 85%
    await spend(userId, [['tea', 'Food', 100]]);
    expect(await budget.checkAfterSpend(userId)).toBeNull(); // still 80s: no repeat

    await spend(userId, [['phone', 'Shopping', 2000]]);
    const over = await budget.checkAfterSpend(userId); // 106%
    expect(over?.level).toBe(100);
    expect(over?.status.remainingPaise).toBe(-60_000);

    await spend(userId, [['snack', 'Food', 50]]);
    expect(await budget.checkAfterSpend(userId)).toBeNull();
  });

  it('a single big expense past 100% alerts once, at 100%', async () => {
    const userId = await createTestUser(database, 'jump@example.com');
    const budget = createBudgetService(database.collections, TZ);
    await budget.setBudget(userId, 500_000);
    await spend(userId, [['laptop', 'Shopping', 6000]]);
    expect((await budget.checkAfterSpend(userId))?.level).toBe(100);
    expect(await budget.checkAfterSpend(userId)).toBeNull();
  });

  it('does not re-alert for levels already reached when the budget was set', async () => {
    const userId = await createTestUser(database, 'preset@example.com');
    const budget = createBudgetService(database.collections, TZ);
    await spend(userId, [['rent', 'Rent', 9000]]);
    await budget.setBudget(userId, 1_000_000); // already at 90%
    await spend(userId, [['tea', 'Food', 20]]);
    expect(await budget.checkAfterSpend(userId)).toBeNull();
  });

  it('starts fresh in a new month', async () => {
    const userId = await createTestUser(database, 'newmonth@example.com');
    const budget = createBudgetService(database.collections, TZ);
    await budget.setBudget(userId, 100_000);
    await spend(userId, [['dinner', 'Food', 900]]);
    expect((await budget.checkAfterSpend(userId))?.level).toBe(80);

    // Pretend the stored alerts belong to an earlier month
    await database.collections.userPreferences.updateOne(
      { user_id: new ObjectId(userId) },
      { $set: { budget_alert_month: '1999-01' } }
    );
    expect((await budget.checkAfterSpend(userId))?.level).toBe(80);
  });

  it('add_expenses returns the warning with the confirmation', async () => {
    const userId = await createTestUser(database, 'tool@example.com');
    await createBudgetService(database.collections, TZ).setBudget(userId, 100_000); // ₹1,000
    const addTool = initTools(database.collections, TZ).find((t) => t.name === 'add_expenses')!;
    const invoke = (items: unknown) =>
      (addTool as unknown as { invoke: (i: unknown, c: unknown) => Promise<string> }).invoke(
        { items },
        { configurable: { userId, channel: 'web' } }
      );

    const quiet = JSON.parse(await invoke([{ title: 'tea', amount: 100, category: 'Food' }]));
    expect(quiet.budgetAlert).toBeUndefined();
    const warned = JSON.parse(await invoke([{ title: 'pizza', amount: 750, category: 'Food' }]));
    expect(warned.budgetAlert.level).toBe(80);
  });
});

describe('budget texts', () => {
  const status = {
    month: '2026-10',
    budgetPaise: 2_000_000,
    spentPaise: 1_700_000,
    remainingPaise: 300_000,
    usedPct: 85,
    daysLeft: 7,
    dailyAllowancePaise: 42_857,
    topFlexible: { category: 'Food', totalPaise: 600_000 },
  };

  it('writes the 80% warning with a daily allowance and a tip', () => {
    expect(budgetAlertText('english', 80, status)).toBe(
      "⚠️ You've used 85% of your ₹20,000 budget for October (₹17,000). ₹3,000 is left for 7 days, about ₹428.57 a day. Food is your biggest flexible spend this month (₹6,000), so that's the easiest place to cut back."
    );
    expect(budgetAlertText('hinglish', 80, status)).toContain('October ka 85% budget use ho gaya');
  });

  it('writes the over-budget warning', () => {
    const over = { ...status, spentPaise: 2_120_000, remainingPaise: -120_000, usedPct: 106, dailyAllowancePaise: 0 };
    expect(budgetAlertText('english', 100, over)).toContain("You've crossed your ₹20,000 budget for October: ₹21,200 spent (₹1,200 over)");
    expect(budgetAlertText('hinglish', 100, over)).toContain('budget cross ho gaya');
  });

  it('describes the status', () => {
    expect(budgetStatusText('english', status)).toBe(
      'Your October budget is ₹20,000. You\'ve spent ₹17,000 (85%), with ₹3,000 left: about ₹428.57 a day for the next 7 days.'
    );
  });

  it('Telegram sends the warning as its own message', () => {
    const replies = buildTurnReplies(
      [
        { type: 'human', text: 'pizza 750' },
        {
          type: 'tool',
          text: JSON.stringify({
            type: 'expenses_added',
            totalPaise: 75_000,
            byCategory: [{ category: 'Food', totalPaise: 75_000 }],
            budgetAlert: { level: 80, status },
          }),
        },
      ],
      'https://app.example'
    );
    expect(replies).toHaveLength(2);
    expect(replies[0]).toBe('✅ ₹750 added (Food ₹750)');
    expect(replies[1]).toContain("You've used 85%");
  });
});

describe('budget REST endpoints', () => {
  it('sets, reads and clears the budget for the logged-in user', async () => {
    const config = loadConfig({ JWT_SECRET: 'test-secret' });
    const app = createApp({
      config,
      database,
      getAgent: () => {
        throw new Error('not needed');
      },
      bot: null,
    });
    const userId = await createTestUser(database, 'rest-budget@example.com');
    const auth = { Authorization: `Bearer ${signToken(userId, config)}` };

    expect((await request(app).get('/budget').set(auth).expect(200)).body.status).toBeNull();
    const set = await request(app).put('/budget').set(auth).send({ amount: 15000 }).expect(200);
    expect(set.body.status.budgetPaise).toBe(1_500_000);
    await request(app).put('/budget').set(auth).send({ amount: -5 }).expect(400);
    await request(app).delete('/budget').set(auth).expect(200);
    expect((await request(app).get('/budget').set(auth).expect(200)).body.status).toBeNull();
    await request(app).get('/budget').expect(401);
  });
});

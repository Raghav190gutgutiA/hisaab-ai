import * as z from 'zod';
import { fromBsonInt, toBsonInt, type Collections } from '../db.ts';
import { monthRange, todayIn } from '../dates.ts';
import { toObjectId, type Category } from './expenses.ts';

export const BUDGET_LEVELS = [80, 100] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

// Fixed costs are not where people can cut back, so suggestions skip them
const FIXED_CATEGORIES = new Set<string>(['Rent', 'Bills', 'Health', 'Education']);

export const budgetPaiseSchema = z
  .number()
  .int()
  .min(100, 'Budget must be at least ₹1')
  .max(100_000_000_00, 'Budget is unrealistically large');

export type BudgetStatus = {
  month: string; // YYYY-MM
  budgetPaise: number;
  spentPaise: number;
  remainingPaise: number; // negative when over budget
  usedPct: number;
  daysLeft: number; // including today
  dailyAllowancePaise: number; // what can still be spent per day
  /** Biggest flexible (non-fixed) category this month */
  topFlexible: { category: Category; totalPaise: number } | null;
};

export type BudgetAlert = { level: BudgetLevel; status: BudgetStatus };

/** Highest threshold the spending has reached, if any. */
export function reachedLevel(usedPct: number): BudgetLevel | null {
  if (usedPct >= 100) return 100;
  if (usedPct >= 80) return 80;
  return null;
}

export function createBudgetService({ userPreferences, expenses }: Collections, timeZone: string) {
  async function getBudgetPaise(userId: string): Promise<number | null> {
    const doc = await userPreferences.findOne({ user_id: toObjectId(userId) });
    return doc?.monthly_budget_paise ? fromBsonInt(doc.monthly_budget_paise) : null;
  }

  /** This month's spending against the budget, or null when no budget is set. */
  async function getStatus(userId: string, now = new Date()): Promise<BudgetStatus | null> {
    const budgetPaise = await getBudgetPaise(userId);
    if (!budgetPaise) return null;

    const { from, to } = monthRange(timeZone, now);
    const byCategory = await expenses
      .aggregate<{ _id: Category; total: number }>([
        { $match: { user_id: toObjectId(userId), spent_on: { $gte: from, $lte: to } } },
        { $group: { _id: '$category', total: { $sum: '$amount_paise' } } },
        { $sort: { total: -1 } },
      ])
      .toArray();

    const spentPaise = byCategory.reduce((sum, row) => sum + Number(row.total), 0);
    const today = todayIn(timeZone, now);
    const daysLeft = Number(to.slice(8, 10)) - Number(today.slice(8, 10)) + 1;
    const remainingPaise = budgetPaise - spentPaise;
    const flexible = byCategory.find((row) => !FIXED_CATEGORIES.has(row._id));

    return {
      month: from.slice(0, 7),
      budgetPaise,
      spentPaise,
      remainingPaise,
      usedPct: Math.round((spentPaise / budgetPaise) * 1000) / 10,
      daysLeft,
      dailyAllowancePaise: remainingPaise > 0 ? Math.floor(remainingPaise / daysLeft) : 0,
      topFlexible: flexible ? { category: flexible._id, totalPaise: Number(flexible.total) } : null,
    };
  }

  /**
   * Sets the budget and returns the current status. Thresholds already
   * reached are marked as alerted, since the reply shows the status anyway.
   */
  async function setBudget(userId: string, budgetPaise: number): Promise<BudgetStatus> {
    budgetPaiseSchema.parse(budgetPaise);
    const user = toObjectId(userId);
    await userPreferences.updateOne(
      { user_id: user },
      { $set: { monthly_budget_paise: toBsonInt(budgetPaise), updated_at: new Date() } },
      { upsert: true }
    );

    const status = (await getStatus(userId))!;
    const reached = reachedLevel(status.usedPct);
    await userPreferences.updateOne(
      { user_id: user },
      {
        $set: {
          budget_alert_month: status.month,
          budget_alert_levels: BUDGET_LEVELS.filter((level) => reached !== null && level <= reached),
        },
      }
    );
    return status;
  }

  async function clearBudget(userId: string) {
    await userPreferences.updateOne(
      { user_id: toObjectId(userId) },
      {
        $unset: { monthly_budget_paise: '', budget_alert_month: '', budget_alert_levels: '' },
        $set: { updated_at: new Date() },
      }
    );
  }

  /**
   * Called after expenses are logged. Returns an alert the first time this
   * month's spending reaches 80% or 100% of the budget, and records it so
   * the same warning is never repeated within the month.
   */
  async function checkAfterSpend(userId: string, now = new Date()): Promise<BudgetAlert | null> {
    const status = await getStatus(userId, now);
    if (!status) return null;
    const level = reachedLevel(status.usedPct);
    if (!level) return null;

    const user = toObjectId(userId);
    const doc = await userPreferences.findOne({ user_id: user });
    const sent = doc?.budget_alert_month === status.month ? (doc.budget_alert_levels ?? []) : [];
    if (sent.includes(level)) return null;

    // Reaching 100% also covers 80%, so a jump straight past both alerts once
    const newLevels = BUDGET_LEVELS.filter((l) => l <= level);
    // Conditional update: if another request recorded this level first, skip
    const result = await userPreferences.updateOne(
      {
        user_id: user,
        $or: [{ budget_alert_month: { $ne: status.month } }, { budget_alert_levels: { $ne: level } }],
      },
      { $set: { budget_alert_month: status.month, budget_alert_levels: newLevels } }
    );
    return result.modifiedCount === 1 ? { level, status } : null;
  }

  /**
   * After expenses are deleted, forget alerts for levels no longer reached,
   * so crossing them again later this month warns again.
   */
  async function recheckAfterRemoval(userId: string, now = new Date()) {
    const status = await getStatus(userId, now);
    if (!status) return;
    const reached = reachedLevel(status.usedPct);
    await userPreferences.updateOne(
      { user_id: toObjectId(userId), budget_alert_month: status.month },
      { $set: { budget_alert_levels: BUDGET_LEVELS.filter((level) => reached !== null && level <= reached) } }
    );
  }

  return { getBudgetPaise, getStatus, setBudget, clearBudget, checkAfterSpend, recheckAfterRemoval };
}

export type BudgetService = ReturnType<typeof createBudgetService>;

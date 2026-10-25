import { randomBytes } from 'node:crypto';
import type { Collections } from '../db.ts';
import { toObjectId, type Expense, type ExpenseService, type RemovalFilter } from './expenses.ts';
import type { BudgetService } from './budget.ts';

// Show at most this many matches; more means the request is too broad
export const MAX_REMOVAL_MATCHES = 20;
const CONFIRM_TTL_MS = 10 * 60 * 1000;

export type RemovalPreview = {
  matches: Expense[];
  totalPaise: number;
  /** Carried by the Delete button; null when there is nothing to confirm */
  token: string | null;
  tooMany: boolean;
};

export type RemovalResult =
  | { ok: true; deleted: Expense[]; totalPaise: number }
  | { ok: false; reason: 'expired' };

/**
 * Deleting is always two steps: the server finds the matching expenses,
 * then nothing is removed until the user confirms with a button. The model
 * only describes what to look for; it never picks or deletes records.
 */
export function createRemovalService(
  { pendingDeletes }: Collections,
  expenses: ExpenseService,
  budget: BudgetService
) {
  async function preview(userId: string, filter: RemovalFilter): Promise<RemovalPreview> {
    const found = await expenses.findForRemoval(userId, filter, MAX_REMOVAL_MATCHES + 1);
    const tooMany = found.length > MAX_REMOVAL_MATCHES;
    const matches = found.slice(0, MAX_REMOVAL_MATCHES);
    const totalPaise = matches.reduce((sum, e) => sum + e.amountPaise, 0);

    if (matches.length === 0 || tooMany) return { matches, totalPaise, token: null, tooMany };

    const token = randomBytes(9).toString('base64url');
    await pendingDeletes.insertOne({
      _id: token,
      user_id: toObjectId(userId),
      expense_ids: matches.map((e) => toObjectId(e.id)),
      expires_at: new Date(Date.now() + CONFIRM_TTL_MS),
    });
    return { matches, totalPaise, token, tooMany };
  }

  /** Uses up the token (so a double tap can't delete twice), then deletes. */
  async function confirm(userId: string, token: string): Promise<RemovalResult> {
    const pending = await pendingDeletes.findOneAndDelete({ _id: token, user_id: toObjectId(userId) });
    if (!pending || pending.expires_at <= new Date()) return { ok: false, reason: 'expired' };

    const deleted = await expenses.removeByIds(userId, pending.expense_ids);
    await budget.recheckAfterRemoval(userId);
    return { ok: true, deleted, totalPaise: deleted.reduce((sum, e) => sum + e.amountPaise, 0) };
  }

  async function cancel(userId: string, token: string) {
    await pendingDeletes.deleteOne({ _id: token, user_id: toObjectId(userId) });
  }

  /** Direct delete of one expense (the web table's delete button). */
  async function removeOne(userId: string, expenseId: string): Promise<Expense | null> {
    const [deleted] = await expenses.removeByIds(userId, [toObjectId(expenseId)]);
    if (deleted) await budget.recheckAfterRemoval(userId);
    return deleted ?? null;
  }

  return { preview, confirm, cancel, removeOne };
}

export type RemovalService = ReturnType<typeof createRemovalService>;

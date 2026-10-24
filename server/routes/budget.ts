import { Router } from 'express';
import * as z from 'zod';
import type { AppConfig } from '../config.ts';
import { requireAuth } from '../auth.ts';
import { rupeesToPaise } from '../money.ts';
import type { BudgetService } from '../services/budget.ts';

const budgetSchema = z.object({
  amount: z.number().min(1, 'Budget must be at least ₹1').max(10_000_000),
});

/**
 * Monthly budget for the web Settings panel. Chat and Telegram set it
 * through the agent's set_budget tool, which uses the same service.
 */
export function createBudgetRouter(config: AppConfig, budget: BudgetService) {
  const router = Router();
  router.use(requireAuth(config));

  router.get('/', async (req, res) => {
    res.json({ status: await budget.getStatus(req.userId!) });
  });

  router.put('/', async (req, res) => {
    const parsed = budgetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Enter a monthly budget between ₹1 and ₹1,00,00,000' });
      return;
    }
    res.json({ status: await budget.setBudget(req.userId!, rupeesToPaise(parsed.data.amount)) });
  });

  router.delete('/', async (req, res) => {
    await budget.clearBudget(req.userId!);
    res.json({ status: null });
  });

  return router;
}

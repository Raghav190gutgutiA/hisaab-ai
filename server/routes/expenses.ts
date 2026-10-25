import { Router } from 'express';
import { ObjectId } from 'mongodb';
import * as z from 'zod';
import type { AppConfig } from '../config.ts';
import { requireAuth } from '../auth.ts';
import type { RemovalService } from '../services/removal.ts';

const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/) });

/**
 * Deleting expenses from the web app. Chat deletes are two-step: the
 * delete_expenses tool shows matches with a token, confirmed here.
 */
export function createExpensesRouter(config: AppConfig, removal: RemovalService) {
  const router = Router();
  router.use(requireAuth(config));

  router.post('/delete/confirm', async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid delete request' });
      return;
    }
    const result = await removal.confirm(req.userId!, parsed.data.token);
    if (!result.ok) {
      res.status(410).json({ error: 'This delete request expired. Please ask again.' });
      return;
    }
    res.json({ deleted: result.deleted, totalPaise: result.totalPaise });
  });

  router.post('/delete/cancel', async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body);
    if (parsed.success) await removal.cancel(req.userId!, parsed.data.token);
    res.json({ ok: true });
  });

  router.delete('/:id', async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      res.status(400).json({ error: 'Invalid expense id' });
      return;
    }
    const deleted = await removal.removeOne(req.userId!, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }
    res.json({ deleted });
  });

  return router;
}

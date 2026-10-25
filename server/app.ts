import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { Update } from 'grammy/types';
import type { AppConfig } from './config.ts';
import type { Database } from './db.ts';
import type { Agent } from './agent.ts';
import { createAuthRouter } from './auth.ts';
import { createChatRouter } from './routes/chat.ts';
import { createTelegramRouter } from './routes/telegram.ts';
import { createUserService } from './services/users.ts';
import { createTelegramLinkService } from './services/telegramLink.ts';
import { createBudgetService } from './services/budget.ts';
import { createBudgetRouter } from './routes/budget.ts';
import { createExpensesRouter } from './routes/expenses.ts';
import { createRemovalService } from './services/removal.ts';
import { createExpenseService } from './services/expenses.ts';
import { verifyTelegramSecret, type HisaabBot } from './telegram/bot.ts';

export type AppDeps = {
  config: AppConfig;
  database: Database;
  getAgent: () => Agent;
  bot: HisaabBot | null;
};

export function createApp({ config, database, getAgent, bot }: AppDeps) {
  const app = express();
  const users = createUserService(database.collections);
  const links = createTelegramLinkService(database.collections);

  app.disable('x-powered-by');
  // Render (and most hosts) sit behind one proxy hop
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));
  app.use(
    cors({
      origin(origin, callback) {
        // Requests without an Origin (curl, health checks, Telegram) are not browser CORS
        callback(null, !origin || config.allowedOrigins.includes(origin));
      },
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    })
  );

  /**
   * Liveness check for Render and uptime monitors. Deliberately touches
   * neither the database nor Gemini so it stays fast and free.
   */
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  app.get('/', (_req, res) => {
    res.json({ message: 'OK' });
  });

  if (bot && config.TELEGRAM_MODE === 'webhook') {
    /**
     * Acknowledge immediately, then process. Agent runs can take several
     * seconds; a slow 200 would make Telegram retry the same update.
     * Duplicate update_ids are dropped by the bot's dedupe middleware.
     */
    app.post('/telegram/webhook', verifyTelegramSecret(config.TELEGRAM_WEBHOOK_SECRET!), (req, res) => {
      res.sendStatus(200);
      const update = req.body as Update;
      if (typeof update?.update_id !== 'number') return;
      // A cold start can receive an update before startup finished init()
      (bot.isInited() ? Promise.resolve() : bot.init())
        .then(() => bot.handleUpdate(update))
        .catch((error) => {
          console.error(`Telegram update ${update.update_id} failed:`, error);
        });
    });
  }

  app.use('/auth', createAuthRouter(config, users));
  app.use('/telegram', createTelegramRouter(config, links, () => bot));
  const budget = createBudgetService(database.collections, config.APP_TIMEZONE);
  const removal = createRemovalService(database.collections, createExpenseService(database.collections), budget);
  app.use('/budget', createBudgetRouter(config, budget));
  app.use('/expenses', createExpensesRouter(config, removal));
  app.use('/', createChatRouter(config, getAgent, users));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  return app;
}

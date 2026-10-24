import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { loadConfig } from './config.ts';
import { initDB } from './db.ts';
import { createAgent, type Agent } from './agent.ts';
import { createChatModel } from './llm.ts';
import { createApp } from './app.ts';
import { createExpenseService } from './services/expenses.ts';
import { createUserService } from './services/users.ts';
import { createBudgetService } from './services/budget.ts';
import { createTelegramLinkService } from './services/telegramLink.ts';
import { createBot, startBot, type HisaabBot } from './telegram/bot.ts';

const CHECKPOINT_TTL_SECONDS = 60 * 60 * 24 * 30;

async function main() {
  const config = loadConfig();
  const production = config.NODE_ENV === 'production';
  // Production migrations run once from a workstation with "pnpm db:migrate";
  // locally they apply automatically for convenience.
  const database = await initDB(config.DATABASE_URL, { migrate: !production, production });
  console.log(`Connected to MongoDB database "${database.db.databaseName}"`);

  // Conversation state survives restarts, so a paused format picker can
  // still be answered later. Idle threads expire after 30 days.
  const checkpointer = new MongoDBSaver({
    client: database.client,
    dbName: database.db.databaseName,
    ttl: CHECKPOINT_TTL_SECONDS,
  });
  await checkpointer.setup();

  // Created on first use so the server (and Telegram linking) can start
  // even before GEMINI_API_KEY is configured.
  let agent: Agent | undefined;
  const getAgent = () =>
    (agent ??= createAgent({
      collections: database.collections,
      checkpointer,
      models: {
        light: createChatModel(config, 'light'),
        mid: createChatModel(config, 'mid'),
      },
      timeZone: config.APP_TIMEZONE,
      historyMessages: config.AGENT_HISTORY_MESSAGES,
    }));

  let bot: HisaabBot | null = null;
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_MODE !== 'off') {
    bot = createBot({
      config,
      links: createTelegramLinkService(database.collections),
      expenses: createExpenseService(database.collections),
      users: createUserService(database.collections),
      budget: createBudgetService(database.collections, config.APP_TIMEZONE),
      getAgent,
      updates: database.collections.telegramUpdates,
    });
  } else {
    console.log('Telegram bot disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_MODE)');
  }

  const app = createApp({ config, database, getAgent, bot });
  const server = app.listen(config.PORT, (error) => {
    if (error) {
      console.error(`Could not listen on port ${config.PORT}:`, error.message);
      process.exit(1);
    }
    console.log(`Server is listening on port ${config.PORT}`);
  });

  if (bot) {
    startBot(bot, config).catch((error) =>
      console.error('Telegram bot failed to start:', error.message)
    );
  }

  async function shutdown() {
    await bot?.stop().catch(() => {});
    server.close();
    await database.client.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

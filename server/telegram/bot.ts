import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Bot, type Context } from 'grammy';
import { MongoServerError, type Collection } from 'mongodb';
import type { AppConfig } from '../config.ts';
import type { TelegramUpdateDoc } from '../db.ts';
import { parseToolResult, terminalReply, type Agent } from '../agent.ts';
import { userFacingError } from '../llm.ts';
import { monthRange, todayIn } from '../dates.ts';
import { summarize, type ExpenseService } from '../services/expenses.ts';
import { maskEmail, type TelegramLinkService } from '../services/telegramLink.ts';
import type { UserService } from '../services/users.ts';
import type { ExpensesAddedResult, ExpensesResult } from '../types.ts';
import type { ExpenseAnalysis } from '../services/analysis.ts';
import { budgetAlertText, budgetStatusText, detectLanguage, noBudgetText } from '../language.ts';
import type { BudgetService } from '../services/budget.ts';
import {
  describeAnalysis,
  describeExpenses,
  escapeHtml,
  formatAddedConfirmation,
  HELP_TEXT,
  unlinkedText,
} from './format.ts';

type BotContext = Context & { userId?: string };

export type BotDeps = {
  config: AppConfig;
  links: TelegramLinkService;
  expenses: ExpenseService;
  users: UserService;
  budget: BudgetService;
  getAgent: () => Agent;
  /** Seen update_ids, used to drop Telegram's retried deliveries */
  updates: Collection<TelegramUpdateDoc>;
};

/**
 * Records every update_id once (unique _id). A retried delivery hits the
 * duplicate key and is skipped. If the store is unavailable the update is
 * still processed: missing a message is worse than a rare double.
 */
export function dedupeUpdates(updates: Collection<TelegramUpdateDoc>) {
  return async (ctx: Context, next: () => Promise<void>) => {
    try {
      await updates.insertOne({ _id: ctx.update.update_id, received_at: new Date() });
    } catch (error) {
      if (error instanceof MongoServerError && error.code === 11000) {
        console.info(`Skipping duplicate Telegram update ${ctx.update.update_id}`);
        return;
      }
      console.error('Telegram dedupe store unavailable:', error);
    }
    await next();
  };
}

const TEXT_OPTIONS = {
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
};

/**
 * Builds Telegram replies from structured tool results rather than LLM
 * text, so the numbers are exact. Every reply is natural language: lists
 * and analyses are written as sentences, never as tables or JSON.
 */
export function buildTurnReplies(
  messages: { type: string; text: string }[],
  dashboardUrl: string
): string[] {
  const replies: string[] = [];
  const lastHuman = messages.findLast((m) => m.type === 'human');
  const language = detectLanguage(lastHuman?.text ?? '');
  // Analysis is followed by the model's written insights
  let wantsInsights = false;

  for (const message of messages) {
    if (message.type !== 'tool') continue;
    const result = parseToolResult(message as never);
    if (result?.type === 'expenses_added') {
      const added = result as ExpensesAddedResult;
      replies.push(formatAddedConfirmation(added, language));
      // Budget warning (80% / 100%) as its own message so it stands out
      if (added.budgetAlert) {
        replies.push(escapeHtml(budgetAlertText(language, added.budgetAlert.level, added.budgetAlert.status)));
      }
    } else if (result?.type === 'budget') {
      replies.push(escapeHtml(terminalReply(result, language)));
    } else if (result?.type === 'expenses') {
      const { expenses, summary } = result as ExpensesResult;
      replies.push(describeExpenses(expenses, summary, language, dashboardUrl));
    } else if (result?.type === 'analysis') {
      replies.push(describeAnalysis(result as ExpenseAnalysis, language));
      wantsInsights = true;
    } else if (result?.type === 'chart') {
      replies.push(
        language === 'hinglish'
          ? `📊 Charts web dashboard pe dekh sakte ho: ${escapeHtml(dashboardUrl)}`
          : `📊 Charts are available on the web dashboard: ${escapeHtml(dashboardUrl)}`
      );
    }
  }

  if (replies.length === 0 || wantsInsights) {
    const lastAi = messages.findLast((m) => m.type === 'ai' && m.text.trim());
    if (wantsInsights && !lastAi) return replies;
    replies.push(escapeHtml(lastAi?.text ?? "Sorry, I couldn't process that."));
  }
  return replies;
}

export function createBot(deps: BotDeps) {
  const { config, links, expenses, users } = deps;
  const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN!);
  const dashboardUrl = config.APP_FRONTEND_URL;

  async function sendExpenses(ctx: BotContext, range: { from: string; to: string }) {
    const list = await expenses.listExpenses(ctx.userId!, range);
    await ctx.reply(describeExpenses(list, summarize(list, range), 'english', dashboardUrl), TEXT_OPTIONS);
  }

  /** Partly hidden email of an account, e.g. "r*****@gmail.com". */
  async function accountLabel(userId: string): Promise<string> {
    const user = await users.findById(userId);
    return user ? maskEmail(user.email) : 'your Hisaab.ai account';
  }

  const linkFailure = (reason: 'invalid' | 'expired') =>
    reason === 'expired'
      ? '⌛ This link code has expired. Generate a new one from the web app (codes last 10 minutes).'
      : '❌ Invalid link code. Generate a new one from the web app and try again.';

  /** Uses up the code and confirms which account the chat is now linked to. */
  async function completeLink(ctx: BotContext, code: string, edit = false) {
    const result = await links.consumeLinkCode(code, String(ctx.chat!.id));
    const text = result.ok
      ? `✅ Telegram connected to <b>${escapeHtml(await accountLabel(result.userId))}</b>.\n\nTry: <code>tea 20, taxi 80</code> or /today`
      : linkFailure(result.reason);
    if (edit) await ctx.editMessageText(text, { parse_mode: 'HTML' }).catch(() => ctx.reply(text, { parse_mode: 'HTML' }));
    else await ctx.reply(text, { parse_mode: 'HTML' });
  }

  /**
   * Links the chat, but first asks for confirmation when it is already
   * linked to a different account, so expenses never silently start going
   * to another account.
   */
  async function linkChat(ctx: BotContext, code: string) {
    const check = await links.inspectLinkCode(code, String(ctx.chat!.id));
    if (!check.ok) {
      await ctx.reply(linkFailure(check.reason));
      return;
    }
    if (!check.currentUserId || check.currentUserId === check.userId) {
      await completeLink(ctx, code);
      return;
    }

    const [current, next] = await Promise.all([accountLabel(check.currentUserId), accountLabel(check.userId)]);
    await ctx.reply(
      `⚠️ This chat is connected to <b>${escapeHtml(current)}</b>.\n\n` +
        `Switch it to <b>${escapeHtml(next)}</b>? New expenses from Telegram will go to ${escapeHtml(next)}. ` +
        `Expenses you already logged stay in ${escapeHtml(current)}.`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              // The code is safe here: only this chat sees the buttons, and it stays single-use
              { text: `Yes, switch`, callback_data: `link:yes:${code.trim()}` },
              { text: `No, keep ${current}`, callback_data: 'link:no' },
            ],
          ],
        },
      }
    );
  }

  /** Runs one message through the shared agent and sends the replies. */
  async function runTextTurn(ctx: BotContext, text: string) {
    const chatId = ctx.chat!.id;
    await ctx.replyWithChatAction('typing').catch(() => {});

    try {
      const messages = await deps.getAgent().runTurn(
        { userId: ctx.userId!, channel: 'telegram', threadId: `tg:${chatId}` },
        text.slice(0, 2000)
      );
      for (const reply of buildTurnReplies(messages, dashboardUrl)) {
        await ctx.reply(reply, TEXT_OPTIONS);
      }
    } catch (error) {
      console.error('Telegram agent run failed:', error);
      await ctx.reply(userFacingError(error));
    }
  }

  // Telegram retries webhook deliveries; never process an update twice
  bot.use(dedupeUpdates(deps.updates));

  // Expenses are personal: only private chats are supported
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      if (ctx.message) await ctx.reply('Please message me in a private chat.');
      return;
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    const code = ctx.match.trim();
    if (code) return linkChat(ctx, code);

    const linked = await links.getUserIdByChat(String(ctx.chat.id));
    await ctx.reply(
      linked
        ? `👋 Welcome back! This chat is connected to <b>${escapeHtml(await accountLabel(linked))}</b>.\n\n${HELP_TEXT}`
        : `👋 Welcome to Hisaab.ai!\n\n${unlinkedText(config.APP_FRONTEND_URL)}`,
      { parse_mode: 'HTML' }
    );
  });

  // Answer to "switch this chat to another account?"
  bot.callbackQuery(/^link:(yes|no)(?::([A-Za-z0-9_-]{16,64}))?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, answer, code] = ctx.match as RegExpMatchArray;
    if (answer === 'yes' && code) {
      await completeLink(ctx, code, true);
    } else {
      const current = await links.getUserIdByChat(String(ctx.chat!.id));
      await ctx
        .editMessageText(
          current
            ? `👍 Kept this chat connected to <b>${escapeHtml(await accountLabel(current))}</b>.`
            : '👍 Okay, nothing changed.',
          { parse_mode: 'HTML' }
        )
        .catch(() => {});
    }
  });

  bot.command('link', async (ctx) => {
    const code = ctx.match.trim();
    if (!code) {
      await ctx.reply('Usage: /link <code>\nGet a code from Connect Telegram in the web app.');
      return;
    }
    await linkChat(ctx, code);
  });

  bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'HTML' }));

  // Everything below requires a linked account
  bot.use(async (ctx, next) => {
    if (!ctx.chat) return;
    const userId = await links.getUserIdByChat(String(ctx.chat.id));
    if (!userId) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: 'Chat not linked' });
      await ctx.reply(unlinkedText(config.APP_FRONTEND_URL), { parse_mode: 'HTML' });
      return;
    }
    ctx.userId = userId;
    await next();
  });

  bot.command('today', (ctx) => {
    const today = todayIn(config.APP_TIMEZONE);
    return sendExpenses(ctx, { from: today, to: today });
  });

  bot.command('month', (ctx) => sendExpenses(ctx, monthRange(config.APP_TIMEZONE)));

  bot.command('budget', async (ctx) => {
    const status = await deps.budget.getStatus(ctx.userId!);
    await ctx.reply(escapeHtml(status ? budgetStatusText('english', status) : noBudgetText('english')));
  });

  // Format buttons from older messages: Telegram replies are text-only now
  bot.callbackQuery(/^fmt:/, (ctx) =>
    ctx.answerCallbackQuery({ text: 'Open the web dashboard for tables and charts.' })
  );

  // Every text message is processed, even if it repeats an earlier one:
  // two plates of momos for ₹200 are two real expenses. Only Telegram's
  // own retries (same update_id) are dropped, by dedupeUpdates above.
  bot.on('message:text', (ctx) => runTextTurn(ctx, ctx.message.text));

  bot.on('message', (ctx) =>
    ctx.reply('Please send text, e.g. "tea 20, taxi 80". Send /help for more.')
  );

  bot.catch(({ error, ctx }) => {
    console.error(`Telegram update ${ctx.update.update_id} failed:`, error);
  });

  return bot;
}

export type HisaabBot = ReturnType<typeof createBot>;

/**
 * Rejects webhook calls that don't carry our secret in
 * X-Telegram-Bot-Api-Secret-Token (constant-time comparison).
 */
export function verifyTelegramSecret(secret: string) {
  const expected = Buffer.from(secret);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get('X-Telegram-Bot-Api-Secret-Token') ?? '';
    const received = Buffer.from(header);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.status(401).json({ error: 'Invalid secret token' });
      return;
    }
    next();
  };
}

export const BOT_COMMANDS = [
  { command: 'today', description: "Today's expenses" },
  { command: 'month', description: "This month's expenses" },
  { command: 'budget', description: 'Monthly budget: spent and left' },
  { command: 'link', description: 'Link this chat: /link <code>' },
  { command: 'help', description: 'How to use Hisaab.ai' },
];

/**
 * Production (webhook): only initialises the bot. The webhook itself is
 * registered once with `pnpm telegram:set-webhook`, so restarts and cold
 * starts never touch Telegram's settings.
 * Development (polling): long polling, but never on a bot that has a
 * webhook set, since clearing it would take the production bot offline.
 */
export async function startBot(bot: HisaabBot, config: AppConfig) {
  await bot.init();
  await bot.api.setMyCommands(BOT_COMMANDS).catch((error) =>
    console.warn('Could not set bot commands:', error.message)
  );

  if (config.TELEGRAM_MODE === 'webhook') {
    console.log(`Telegram bot @${bot.botInfo.username} ready for webhook updates at /telegram/webhook`);
  } else {
    const info = await bot.api.getWebhookInfo();
    if (info.url) {
      console.warn(
        `Telegram bot @${bot.botInfo.username} has a webhook set (${new URL(info.url).host}), so polling was not started. ` +
          'Use a separate dev bot token locally, or set TELEGRAM_MODE=off.'
      );
      return;
    }
    bot
      .start({
        allowed_updates: ['message', 'callback_query'],
        onStart: (info) => console.log(`Telegram bot @${info.username} polling for updates`),
      })
      .catch((error) => console.error('Telegram polling stopped:', error));
  }
}

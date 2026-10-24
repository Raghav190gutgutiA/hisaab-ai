import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Update } from 'grammy/types';
import { createBot } from '../telegram/bot.ts';
import { loadConfig } from '../config.ts';
import { createExpenseService } from '../services/expenses.ts';
import { createTelegramLinkService, maskEmail } from '../services/telegramLink.ts';
import { createUserService } from '../services/users.ts';
import { createBudgetService } from '../services/budget.ts';
import type { Database } from '../db.ts';
import { startTestDatabase } from './helpers.ts';

let database: Database;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ database, stop } = await startTestDatabase());
});
afterAll(() => stop());

describe('maskEmail', () => {
  it('hides most of the local part', () => {
    expect(maskEmail('raghav@gmail.com')).toBe('r*****@gmail.com');
    expect(maskEmail('ab@x.io')).toBe('a***@x.io');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});

describe('inspectLinkCode', () => {
  it('reports the target and current account without using up the code', async () => {
    const users = createUserService(database.collections);
    const links = createTelegramLinkService(database.collections);
    const a = await users.createUser({ email: 'inspect-a@example.com', name: 'A', passwordHash: 'x' });
    const b = await users.createUser({ email: 'inspect-b@example.com', name: 'B', passwordHash: 'x' });

    await links.consumeLinkCode((await links.createLinkCode(a.id)).code, '7001');
    const { code } = await links.createLinkCode(b.id);

    expect(await links.inspectLinkCode(code, '7001')).toEqual({ ok: true, userId: b.id, currentUserId: a.id });
    expect(await links.inspectLinkCode(code, '7002')).toEqual({ ok: true, userId: b.id, currentUserId: null });
    // Still usable afterwards
    expect(await links.consumeLinkCode(code, '7001')).toEqual({ ok: true, userId: b.id });
    expect(await links.inspectLinkCode('bad', '7001')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('bot: linking a chat that belongs to another account', () => {
  const CHAT = 8001;
  let calls: { method: string; payload: Record<string, any> }[];
  let bot: ReturnType<typeof createBot>;
  let updateId = 5_000;

  beforeEach(() => {
    calls = [];
    bot = createBot({
      config: loadConfig({ JWT_SECRET: 'x', TELEGRAM_BOT_TOKEN: '123:test', APP_FRONTEND_URL: 'https://app.example' }),
      links: createTelegramLinkService(database.collections),
      expenses: createExpenseService(database.collections),
      users: createUserService(database.collections),
      budget: createBudgetService(database.collections, 'Asia/Kolkata'),
      getAgent: () => {
        throw new Error('agent not needed');
      },
      updates: database.collections.telegramUpdates,
    });
    bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'Hisaab',
      username: 'hisaab_test_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as typeof bot.botInfo;
    // Record outgoing Telegram API calls instead of sending them
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, any> });
      return { ok: true, result: method === 'sendMessage' ? { message_id: 1 } : true } as never;
    });
  });

  const message = (text: string): Update => ({
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: 'private', first_name: 'R' },
      from: { id: CHAT, is_bot: false, first_name: 'R' },
      text,
      entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined,
    },
  });

  const tap = (data: string): Update => ({
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      chat_instance: 'x',
      data,
      from: { id: CHAT, is_bot: false, first_name: 'R' },
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT, type: 'private', first_name: 'R' },
        text: 'prompt',
      },
    },
  });

  const lastText = () => calls.filter((c) => ['sendMessage', 'editMessageText'].includes(c.method)).at(-1)?.payload.text;

  it('names the account on first link, then asks before switching', async () => {
    const users = createUserService(database.collections);
    const links = createTelegramLinkService(database.collections);
    const a = await users.createUser({ email: 'owner-a@example.com', name: 'A', passwordHash: 'x' });
    const b = await users.createUser({ email: 'owner-b@example.com', name: 'B', passwordHash: 'x' });

    // A: first link shows which account
    await bot.handleUpdate(message(`/start ${(await links.createLinkCode(a.id)).code}`));
    expect(lastText()).toContain('Telegram connected to <b>o******@example.com</b>');
    expect(await links.getUserIdByChat(String(CHAT))).toBe(a.id);

    // B: a code from another account asks first and changes nothing yet
    const { code } = await links.createLinkCode(b.id);
    await bot.handleUpdate(message(`/link ${code}`));
    const prompt = calls.at(-1)!.payload;
    expect(prompt.text).toContain('⚠️ This chat is connected to');
    expect(prompt.reply_markup.inline_keyboard[0].map((btn: any) => btn.callback_data)).toEqual([
      `link:yes:${code}`,
      'link:no',
    ]);
    expect(Buffer.byteLength(`link:yes:${code}`)).toBeLessThanOrEqual(64);
    expect(await links.getUserIdByChat(String(CHAT))).toBe(a.id);

    // "No" keeps A
    await bot.handleUpdate(tap('link:no'));
    expect(lastText()).toContain('Kept this chat connected to');
    expect(await links.getUserIdByChat(String(CHAT))).toBe(a.id);

    // "Yes" moves the chat to B and burns the code
    await bot.handleUpdate(tap(`link:yes:${code}`));
    expect(lastText()).toContain('Telegram connected to');
    expect(await links.getUserIdByChat(String(CHAT))).toBe(b.id);
    expect(await links.inspectLinkCode(code, String(CHAT))).toEqual({ ok: false, reason: 'invalid' });

    // /start now shows the current account
    await bot.handleUpdate(message('/start'));
    expect(lastText()).toContain('This chat is connected to <b>o******@example.com</b>');
  });

  it('re-linking to the same account needs no confirmation', async () => {
    const users = createUserService(database.collections);
    const links = createTelegramLinkService(database.collections);
    const owner = await users.createUser({ email: 'same@example.com', name: 'S', passwordHash: 'x' });
    await links.consumeLinkCode((await links.createLinkCode(owner.id)).code, String(CHAT));

    await bot.handleUpdate(message(`/link ${(await links.createLinkCode(owner.id)).code}`));
    expect(lastText()).toContain('Telegram connected to <b>s***@example.com</b>');
  });
});

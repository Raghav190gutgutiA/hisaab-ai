import { Router } from 'express';
import type { AppConfig } from '../config.ts';
import { requireAuth } from '../auth.ts';
import type { TelegramLinkService } from '../services/telegramLink.ts';
import type { HisaabBot } from '../telegram/bot.ts';

/**
 * Account linking endpoints for the web app (logged-in users only).
 */
export function createTelegramRouter(
  config: AppConfig,
  links: TelegramLinkService,
  getBot: () => HisaabBot | null
) {
  const router = Router();
  router.use(requireAuth(config));

  function botUsername(): string | null {
    const bot = getBot();
    return (
      config.TELEGRAM_BOT_USERNAME ??
      (bot?.isInited() ? bot.botInfo.username : null)
    );
  }

  router.get('/status', async (req, res) => {
    const chats = await links.getLinkedChats(req.userId!);
    res.json({
      enabled: getBot() !== null,
      botUsername: botUsername(),
      linked: chats.length > 0,
      linkedAt: chats[0]?.linkedAt ?? null,
    });
  });

  router.post('/link-code', async (req, res) => {
    if (!getBot()) {
      res.status(503).json({ error: 'Telegram bot is not configured on the server' });
      return;
    }
    const { code, expiresAt } = await links.createLinkCode(req.userId!);
    const username = botUsername();
    res.json({
      code,
      expiresAt,
      deepLink: username ? `https://t.me/${username}?start=${code}` : null,
    });
  });

  router.delete('/link', async (req, res) => {
    const chatIds = await links.unlinkUser(req.userId!);
    const bot = getBot();
    // Let the chat know how to reconnect, but never fail the request because of Telegram
    const url = config.APP_FRONTEND_URL;
    const message =
      `🔌 This chat was disconnected from Hisaab.ai.\n\n` +
      `To connect again, open <a href="${url}">${url}</a> → ⚙ Settings → Connect Telegram.`;
    await Promise.allSettled(
      chatIds.map((chatId) =>
        bot?.api.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          // Telegram only accepts public (https) URLs on buttons
          ...(url.startsWith('https://') && {
            reply_markup: { inline_keyboard: [[{ text: '🔗 Open Hisaab.ai', url }]] },
          }),
        })
      )
    );
    res.json({ linked: false });
  });

  return router;
}

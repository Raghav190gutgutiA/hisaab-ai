/**
 * Registers or inspects the production Telegram webhook.
 *   pnpm telegram:set-webhook   -> APP_BACKEND_URL/telegram/webhook + secret
 *   pnpm telegram:webhook-info  -> shows what Telegram has registered
 * Secrets are read from the environment and never printed.
 */
import { loadConfig } from '../config.ts';

const config = loadConfig();
const command = process.argv[2];

if (!config.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}

async function callTelegram(method: string, body?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json()) as { ok: boolean; result?: any; description?: string };
  if (!data.ok) throw new Error(`${method} failed: ${data.description ?? response.status}`);
  return data.result;
}

if (command === 'set') {
  if (!config.TELEGRAM_WEBHOOK_SECRET) {
    console.error('TELEGRAM_WEBHOOK_SECRET is not set.');
    process.exit(1);
  }
  if (!config.APP_BACKEND_URL.startsWith('https://')) {
    console.error(`APP_BACKEND_URL must be a public https URL (got ${config.APP_BACKEND_URL}).`);
    process.exit(1);
  }
  const url = `${config.APP_BACKEND_URL}/telegram/webhook`;
  await callTelegram('setWebhook', {
    url,
    secret_token: config.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 10,
  });
  console.log(`Webhook set to ${url}`);
}

const info = await callTelegram('getWebhookInfo');
const me = await callTelegram('getMe');
console.log(`Bot: @${me.username}`);
console.log(`Webhook URL: ${info.url || '(none, polling mode)'}`);
console.log(`Pending updates: ${info.pending_update_count}`);
if (info.last_error_message) {
  const when = new Date(info.last_error_date * 1000).toISOString();
  console.log(`Last error: ${info.last_error_message} (${when})`);
} else {
  console.log('Last error: none');
}

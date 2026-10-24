import { randomBytes } from 'node:crypto';
import * as z from 'zod';

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  // Public URL of the web app: CORS default, Telegram deep/dashboard links
  APP_FRONTEND_URL: z.url().default('http://localhost:5173'),
  // Public URL of this API: used to register the Telegram webhook
  APP_BACKEND_URL: z.url().default('http://localhost:4100'),
  // Extra allowed browser origins, comma separated
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, 'Must be a mongodb:// or mongodb+srv:// URI')
    .default('mongodb://127.0.0.1:27017/hisaab-ai'),

  JWT_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('7d'),

  GEMINI_API_KEY: z.string().optional(),
  // Light tier: tool selection, expense logging, chat replies
  GEMINI_LIGHT_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_LIGHT_THINKING_LEVEL: z.enum(['OFF', 'LOW', 'MEDIUM', 'HIGH']).default('LOW'),
  GEMINI_LIGHT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(512),
  // Mid tier: generated UI content (analysis insights) and fallback when
  // the light model's output fails validation
  GEMINI_MID_MODEL: z.string().default('gemini-3.6-flash'),
  GEMINI_MID_THINKING_LEVEL: z.enum(['OFF', 'LOW', 'MEDIUM', 'HIGH']).default('LOW'),
  GEMINI_MID_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024),
  GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).default(3),
  AGENT_HISTORY_MESSAGES: z.coerce
    .number()
    .int()
    .positive()
    .default(12),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_MODE: z
    .enum(['polling', 'webhook', 'off'])
    .default('polling'),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  JWT_SECRET: string;
  /** Every origin allowed to call the API from a browser */
  allowedOrigins: string[];
};

// Older variable names still accepted so existing .env files keep working
const LEGACY_NAMES: Record<string, string> = {
  WEB_APP_URL: 'APP_FRONTEND_URL',
  PUBLIC_API_URL: 'APP_BACKEND_URL',
  MONGO_URI: 'DATABASE_URL',
};

const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const stripSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Parse and validate environment variables once at startup.
 * Placeholder values from .env.example are treated as unset.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): AppConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(
      ([, value]) =>
        value !== undefined &&
        value !== '' &&
        !value.startsWith('your_')
    )
  );

  for (const [legacy, current] of Object.entries(LEGACY_NAMES)) {
    if (cleaned[legacy] && !cleaned[current]) cleaned[current] = cleaned[legacy];
  }

  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${z.prettifyError(parsed.error)}`
    );
  }

  const config = parsed.data;

  if (!config.JWT_SECRET) {
    if (config.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is required in production');
    }
    console.warn(
      'JWT_SECRET not set: using a temporary secret, sessions reset on restart'
    );
  }

  if (
    config.TELEGRAM_MODE === 'webhook' &&
    !config.TELEGRAM_WEBHOOK_SECRET
  ) {
    throw new Error(
      'TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_MODE=webhook'
    );
  }

  const allowedOrigins = [
    ...new Set(
      [
        config.APP_FRONTEND_URL,
        ...config.CORS_ORIGINS.split(','),
        ...(config.NODE_ENV === 'production' ? [] : DEV_ORIGINS),
      ]
        .map((origin) => stripSlash(origin.trim()))
        .filter(Boolean)
    ),
  ];

  return {
    ...config,
    APP_FRONTEND_URL: stripSlash(config.APP_FRONTEND_URL),
    APP_BACKEND_URL: stripSlash(config.APP_BACKEND_URL),
    allowedOrigins,
    JWT_SECRET:
      config.JWT_SECRET ?? randomBytes(32).toString('hex'),
  };
}

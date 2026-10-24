import {
  ChatGoogleGenerativeAI,
  EmptyContentError,
} from '@langchain/google-genai';
import type { AIMessage } from 'langchain';
import type { AppConfig } from './config.ts';

export type ModelTier = 'light' | 'mid';

/**
 * Creates the Gemini model for a tier. Each tier has its own model name,
 * thinking level and output cap so token usage stays small.
 * 429 and 5xx errors are retried with exponential backoff by LangChain's
 * AsyncCaller (maxRetries); 4xx errors fail fast.
 */
export function createChatModel(config: AppConfig, tier: ModelTier = 'light') {
  if (!config.GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to server/.env (get one at https://aistudio.google.com/apikey)'
    );
  }

  const settings =
    tier === 'mid'
      ? {
          model: config.GEMINI_MID_MODEL,
          thinking: config.GEMINI_MID_THINKING_LEVEL,
          maxOutputTokens: config.GEMINI_MID_MAX_OUTPUT_TOKENS,
        }
      : {
          model: config.GEMINI_LIGHT_MODEL,
          thinking: config.GEMINI_LIGHT_THINKING_LEVEL,
          maxOutputTokens: config.GEMINI_LIGHT_MAX_OUTPUT_TOKENS,
        };

  return new ChatGoogleGenerativeAI({
    apiKey: config.GEMINI_API_KEY,
    model: settings.model,
    temperature: 0.2,
    maxOutputTokens: settings.maxOutputTokens,
    maxRetries: config.GEMINI_MAX_RETRIES,
    ...(settings.thinking !== 'OFF' && {
      thinkingConfig: { thinkingLevel: settings.thinking },
    }),
  });
}

const SAFETY_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
]);

export const FALLBACK_REPLY =
  `Sorry, I didn't catch that. Try something like "tea 20, taxi 80" or "show this month's expenses".`;

export type EmptyResponseAction =
  | { action: 'retry' }
  | { action: 'reply'; text: string };

/**
 * Decides what to do when Gemini returns no text and no tool calls.
 * A malformed tool call is worth one retry; a safety block is not.
 */
export function handleEmptyResponse(
  reason: string | undefined,
  attempt: number,
  tier: ModelTier = 'mid'
): EmptyResponseAction {
  const isSafety = reason !== undefined && SAFETY_REASONS.has(reason);
  // One retry: a malformed call on any tier, or any non-safety empty reply
  // from the light tier (which is then escalated to mid)
  if (attempt === 0 && !isSafety && (reason === 'MALFORMED_FUNCTION_CALL' || tier === 'light')) {
    return { action: 'retry' };
  }
  if (isSafety) {
    return {
      action: 'reply',
      text: "Sorry, I can't help with that. I can log expenses or show your spending.",
    };
  }
  if (reason === 'MAX_TOKENS') {
    return {
      action: 'reply',
      text: 'That request was too long for me to finish. Try a shorter date range or question.',
    };
  }
  return { action: 'reply', text: FALLBACK_REPLY };
}

export function isEmptyResponse(message: AIMessage): boolean {
  return !message.tool_calls?.length && message.text.trim() === '';
}

export function getFinishReason(
  messageOrError: AIMessage | unknown
): string | undefined {
  if (EmptyContentError.isInstance(messageOrError)) {
    return messageOrError.finishReason ?? messageOrError.blockReason;
  }
  const metadata = (messageOrError as AIMessage)?.response_metadata;
  return (metadata?.finishReason ?? metadata?.finish_reason) as string | undefined;
}

export { EmptyContentError };

/** Maps any LLM/agent failure to a message that is safe to show users. */
export function userFacingError(error: unknown): string {
  const status =
    (error as { status?: number })?.status ??
    (error as { response?: { status?: number } })?.response?.status;
  const message = error instanceof Error ? error.message : String(error);

  if (
    status === 429 ||
    /429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)
  ) {
    return 'Hisaab.ai is getting too many requests right now. Please try again in a minute.';
  }
  if (status === 402 || /credits are depleted|billing/i.test(message)) {
    return 'The AI service is out of credits. Please check Gemini billing in Google AI Studio.';
  }
  if (/GEMINI_API_KEY|API key not valid|API_KEY_INVALID/i.test(message)) {
    return 'The AI service is not configured correctly. Please check the Gemini API key.';
  }
  if (status !== undefined && status >= 500) {
    return 'The AI service is temporarily unavailable. Please try again shortly.';
  }
  return 'Something went wrong while processing your request. Please try again.';
}

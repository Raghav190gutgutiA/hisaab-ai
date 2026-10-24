import { Router, type Response } from 'express';
import { Command } from '@langchain/langgraph';
import * as z from 'zod';
import type { AppConfig } from '../config.ts';
import { requireAuth } from '../auth.ts';
import { runConfig, userMessage, type Agent, type RunContext } from '../agent.ts';
import { userFacingError } from '../llm.ts';
import { isScopeRefusal, looksLikeCode, scopeRefusal } from '../guard.ts';
import { detectLanguage } from '../language.ts';
import { expenseFormatSchema, type UserService } from '../services/users.ts';
import type { StreamMessage } from '../types.ts';

const chatSchema = z.object({ query: z.string().trim().min(1).max(2000) });
const resumeSchema = z.object({ format: expenseFormatSchema });

function webContext(userId: string): RunContext {
  return { userId, channel: 'web', threadId: `web:${userId}` };
}

const SSE_PING_MS = 15_000;

function writeEvent(res: Response, eventType: string, message: StreamMessage) {
  res.write(`event: ${eventType}\n`);
  res.write(`data: ${JSON.stringify(message)}\n\n`);
}

/**
 * Runs the agent and forwards its output as Server-Sent Events:
 * - messages: streamed AI text and tool results
 * - custom:   toolCall:start events written by the graph
 * - updates:  used only to detect interrupts (format picker)
 */
async function streamRun(
  res: Response,
  agent: Agent,
  input: Parameters<Agent['agent']['stream']>[0],
  ctx: RunContext,
  userText = ''
) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stop reverse proxies (Render, nginx) from buffering the stream
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // SSE comment lines keep idle proxies from closing a long stream
  const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);

  const controller = new AbortController();
  res.on('close', () => {
    clearInterval(ping);
    controller.abort();
  });

  // Text streamed per AI message, so code can be caught mid-stream
  const streamedText = new Map<string, string>();
  let replaced = false;

  try {
    const response = await agent.agent.stream(input, {
      ...runConfig(ctx),
      streamMode: ['messages', 'custom', 'updates'],
      signal: controller.signal,
    });

    for await (const [eventType, chunk] of response) {
      if (eventType === 'custom') {
        writeEvent(res, eventType, chunk as StreamMessage);
      } else if (eventType === 'updates') {
        const interrupts = (chunk as Record<string, any>).__interrupt__;
        for (const item of interrupts ?? []) {
          if (item.value?.kind === 'format_picker') {
            writeEvent(res, 'interrupt', { type: 'interrupt', payload: item.value });
          }
        }
      } else if (eventType === 'messages') {
        const [message] = chunk as [any, unknown];
        if (message.type === 'ai') {
          const text: string = message.text;
          if (!text || replaced) continue;
          const key: string = message.id ?? 'current';
          const soFar = (streamedText.get(key) ?? '') + text;
          streamedText.set(key, soFar);
          if (looksLikeCode(soFar) || isScopeRefusal(soFar)) {
            // Off-topic reply: swap what was shown for the fixed refusal, in
            // the user's language, and stop
            replaced = true;
            writeEvent(res, eventType, {
              type: 'ai:replace',
              payload: { text: scopeRefusal(detectLanguage(userText)) },
            });
            continue;
          }
          writeEvent(res, eventType, { type: 'ai', payload: { text } });
        } else if (message.type === 'tool') {
          let result: Record<string, any>;
          try {
            result = JSON.parse(message.text);
          } catch {
            result = { type: 'error', message: message.text };
          }
          writeEvent(res, eventType, {
            type: 'tool',
            payload: { name: message.name, result },
          });
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('Agent run failed:', error);
      writeEvent(res, 'error', {
        type: 'error',
        payload: { message: userFacingError(error) },
      });
    }
  }

  clearInterval(ping);
  res.end();
}

export function createChatRouter(
  config: AppConfig,
  getAgent: () => Agent,
  users: UserService
) {
  const router = Router();
  router.use(requireAuth(config));

  router.post('/chat', async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Message must be 1-2000 characters' });
      return;
    }

    const ctx = webContext(req.userId!);
    let agent: Agent;
    try {
      agent = getAgent();
      await agent.cancelPendingInterrupt(ctx);
    } catch (error) {
      console.error('Agent unavailable:', error);
      res.status(503).json({ error: userFacingError(error) });
      return;
    }

    await streamRun(res, agent, userMessage(parsed.data.query), ctx, parsed.data.query);
  });

  /**
   * Human-in-the-loop: resumes a run paused on the format picker.
   */
  router.post('/chat/resume', async (req, res) => {
    const parsed = resumeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'format must be table, json or chart' });
      return;
    }

    const ctx = webContext(req.userId!);
    const agent = getAgent();
    const pending = await agent.getPendingInterrupt(ctx);
    if (pending?.kind !== 'format_picker') {
      res.status(409).json({ error: 'Nothing is waiting for a format choice' });
      return;
    }

    await streamRun(
      res,
      agent,
      new Command({ resume: { format: parsed.data.format } }),
      ctx
    );
  });

  router.get('/preferences', async (req, res) => {
    res.json({ expenseFormat: await users.getExpenseFormat(req.userId!) });
  });

  router.put('/preferences', async (req, res) => {
    const parsed = resumeSchema.safeParse({ format: req.body?.expenseFormat });
    if (!parsed.success) {
      res.status(400).json({ error: 'expenseFormat must be table, json or chart' });
      return;
    }
    await users.setExpenseFormat(req.userId!, parsed.data.format);
    res.json({ expenseFormat: parsed.data.format });
  });

  return router;
}

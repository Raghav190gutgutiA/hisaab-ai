import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from 'langchain';
import { createAgent, pickTier, runConfig, userMessage } from '../agent.ts';
import { handleEmptyResponse } from '../llm.ts';
import { createExpenseService } from '../services/expenses.ts';
import { todayIn } from '../dates.ts';
import type { Database } from '../db.ts';
import { createTestUser, startTestDatabase } from './helpers.ts';

/** Scripted stand-in for a Gemini model that records how often it was called. */
class ScriptedModel {
  calls = 0;
  private responses: AIMessage[];
  constructor(responses: AIMessage[]) {
    this.responses = responses;
  }
  bindTools() {
    return this;
  }
  async invoke() {
    this.calls++;
    const next = this.responses.shift();
    if (!next) throw new Error('ScriptedModel ran out of responses');
    return next;
  }
}

const toolCall = (name: string, args: Record<string, unknown>, id = 'call_1') =>
  new AIMessage({ content: '', tool_calls: [{ id, name, args }] });

let database: Database;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ database, stop } = await startTestDatabase());
});

afterAll(() => stop());

function buildAgent(light: ScriptedModel, mid: ScriptedModel) {
  return createAgent({
    collections: database.collections,
    checkpointer: new MemorySaver(),
    models: { light: light as unknown as BaseChatModel, mid: mid as unknown as BaseChatModel },
    timeZone: 'Asia/Kolkata',
    historyMessages: 12,
  });
}

describe('pickTier', () => {
  it('uses the light model for normal turns', () => {
    expect(pickTier([new HumanMessage('tea 20')])).toEqual({ tier: 'light', reason: 'default' });
  });

  it('uses the mid model to write analysis insights', () => {
    const messages = [
      new HumanMessage('analyse my food spending'),
      toolCall('analyze_expenses', {}),
      new ToolMessage({ content: JSON.stringify({ type: 'analysis' }), tool_call_id: 'call_1' }),
    ];
    expect(pickTier(messages)).toEqual({ tier: 'mid', reason: 'ui-content' });
  });

  it('escalates to mid after a tool call fails validation', () => {
    const messages = [
      new HumanMessage('tea -20'),
      toolCall('add_expenses', {}),
      new ToolMessage({ content: 'Error: invalid input', tool_call_id: 'call_1', status: 'error' }),
    ];
    expect(pickTier(messages)).toEqual({ tier: 'mid', reason: 'tool-validation-failed' });
  });
});

describe('handleEmptyResponse escalation', () => {
  it('retries an empty light-tier reply on mid, but not a safety block', () => {
    expect(handleEmptyResponse('OTHER', 0, 'light')).toEqual({ action: 'retry' });
    expect(handleEmptyResponse(undefined, 0, 'light')).toEqual({ action: 'retry' });
    expect(handleEmptyResponse('OTHER', 0, 'mid').action).toBe('reply');
    expect(handleEmptyResponse('SAFETY', 0, 'light').action).toBe('reply');
  });
});

describe('agent routing end to end', () => {
  it('logs expenses with the light model only', async () => {
    const userId = await createTestUser(database, 'route-log@example.com');
    const light = new ScriptedModel([
      toolCall('add_expenses', { items: [{ title: 'tea', amount: 20, category: 'Food' }] }),
    ]);
    const mid = new ScriptedModel([]);
    const { agent } = buildAgent(light, mid);

    const result = await agent.invoke(
      userMessage('tea 20'),
      runConfig({ userId, channel: 'web', threadId: 'route-log' })
    );

    expect(light.calls).toBe(1);
    expect(mid.calls).toBe(0);
    expect(result.messages.at(-1)!.text).toBe('✅ ₹20 added (Food ₹20)');
  });

  it('falls back to the mid model when the light model sends invalid tool input', async () => {
    const userId = await createTestUser(database, 'route-fallback@example.com');
    const light = new ScriptedModel([
      toolCall('add_expenses', { items: [{ title: 'taxi', amount: -80, category: 'Travel' }] }),
    ]);
    const mid = new ScriptedModel([
      toolCall('add_expenses', { items: [{ title: 'taxi', amount: 80, category: 'Travel' }] }, 'call_2'),
    ]);
    const { agent } = buildAgent(light, mid);

    const result = await agent.invoke(
      userMessage('taxi 80'),
      runConfig({ userId, channel: 'web', threadId: 'route-fallback' })
    );

    expect(light.calls).toBe(1);
    expect(mid.calls).toBe(1);
    expect(result.messages.at(-1)!.text).toBe('✅ ₹80 added (Travel ₹80)');
    const today = todayIn('Asia/Kolkata');
    const saved = await createExpenseService(database.collections).listExpenses(userId, {
      from: today,
      to: today,
    });
    expect(saved.map((x) => x.amountPaise)).toEqual([8000]);
  });

  it('falls back to the mid model on an empty light-tier reply', async () => {
    const userId = await createTestUser(database, 'route-empty@example.com');
    const light = new ScriptedModel([new AIMessage('')]);
    const mid = new ScriptedModel([new AIMessage('How much was the tea?')]);
    const { agent } = buildAgent(light, mid);

    const result = await agent.invoke(
      userMessage('tea'),
      runConfig({ userId, channel: 'web', threadId: 'route-empty' })
    );
    expect([light.calls, mid.calls]).toEqual([1, 1]);
    expect(result.messages.at(-1)!.text).toBe('How much was the tea?');
  });

  it('picks the tool with light, then writes analysis insights with mid', async () => {
    const userId = await createTestUser(database, 'route-analysis@example.com');
    const today = todayIn('Asia/Kolkata');
    await createExpenseService(database.collections).addExpenses(userId, [
      { title: 'lunch', category: 'Food', amountPaise: 20000, spentOn: today },
    ]);
    const light = new ScriptedModel([
      toolCall('analyze_expenses', { from: today, to: today, categories: ['Food'] }),
    ]);
    const mid = new ScriptedModel([new AIMessage('- Food is your only spend today.')]);
    const { agent } = buildAgent(light, mid);

    const result = await agent.invoke(
      userMessage('analyse my food spending today'),
      runConfig({ userId, channel: 'web', threadId: 'route-analysis' })
    );

    expect([light.calls, mid.calls]).toEqual([1, 1]);
    const toolResult = JSON.parse(result.messages.at(-2)!.text);
    expect(toolResult).toMatchObject({ type: 'analysis', totalPaise: 20000, categories: ['Food'] });
    expect(result.messages.at(-1)!.text).toBe('- Food is your only spend today.');
  });
});

describe('repeated expenses are real expenses', () => {
  it('keeps two identical items in one message and the same message sent twice', async () => {
    const userId = await createTestUser(database, 'momos@example.com');
    const momos = { title: 'momos', amount: 200, category: 'Food' };
    const light = new ScriptedModel([
      toolCall('add_expenses', { items: [momos, momos] }),
      toolCall('add_expenses', { items: [momos] }, 'call_2'),
    ]);
    const { agent } = buildAgent(light, new ScriptedModel([]));
    const config = runConfig({ userId, channel: 'telegram', threadId: 'momos' });

    await agent.invoke(userMessage('momos 200, momos 200'), config);
    await agent.invoke(userMessage('momos 200'), config);

    const today = todayIn('Asia/Kolkata');
    const saved = await createExpenseService(database.collections).listExpenses(userId, { from: today, to: today });
    expect(saved.map((x) => [x.title, x.amountPaise])).toEqual([
      ['momos', 20000],
      ['momos', 20000],
      ['momos', 20000],
    ]);
  });
});

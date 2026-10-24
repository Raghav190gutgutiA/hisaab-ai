import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemorySaver, MessagesAnnotation, StateGraph, Command } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AIMessage } from 'langchain';
import { initTools, resolveFormat } from '../tools.ts';
import { createUserService } from '../services/users.ts';
import { createExpenseService } from '../services/expenses.ts';
import { todayIn } from '../dates.ts';
import type { Database } from '../db.ts';
import { createTestUser, startTestDatabase } from './helpers.ts';

const TZ = 'Asia/Kolkata';

let database: Database;
let stop: () => Promise<void>;
let userA: string;
let userB: string;

beforeAll(async () => {
  ({ database, stop } = await startTestDatabase());
  userA = await createTestUser(database, 'a@example.com');
  userB = await createTestUser(database, 'b@example.com');
});

afterAll(() => stop());

type InvokableTool = { invoke: (input: unknown, config?: unknown) => Promise<unknown> };

function getTool(name: string): InvokableTool {
  const tool = initTools(database.collections, TZ).find((t) => t.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool as unknown as InvokableTool;
}

const interruptsOf = (state: object) =>
  (state as { __interrupt__?: { value: unknown }[] }).__interrupt__;

const configFor = (userId: string, channel = 'web') => ({
  configurable: { userId, channel },
});

describe('add_expenses', () => {
  it('stores amounts as integer paise and summarises by category', async () => {
    const raw = await getTool('add_expenses').invoke(
      {
        items: [
          { title: 'tea', amount: 20, category: 'Food' },
          { title: 'taxi', amount: 80.5, category: 'Travel' },
        ],
      },
      configFor(userA)
    );
    const result = JSON.parse(raw as string);

    expect(result.type).toBe('expenses_added');
    expect(result.totalPaise).toBe(10050);
    expect(result.summary).toBe('₹100.5 added (Travel ₹80.5, Food ₹20)');

    const doc = await database.collections.expenses.findOne({ title: 'taxi' });
    expect(doc?.amount_paise).toBe(8050);
    expect(doc?.spent_on).toBe(todayIn(TZ));
  });

  it('rejects invalid input via Zod', async () => {
    const tool = getTool('add_expenses');
    await expect(
      tool.invoke({ items: [{ title: 'x', amount: -5, category: 'Food' }] }, configFor(userA))
    ).rejects.toThrow();
    await expect(
      tool.invoke({ items: [{ title: 'x', amount: 5, category: 'Snacks' }] }, configFor(userA))
    ).rejects.toThrow();
    await expect(
      tool.invoke(
        { items: [{ title: 'x', amount: 5, category: 'Food', date: '2026-02-30' }] },
        configFor(userA)
      )
    ).rejects.toThrow();
    await expect(tool.invoke({ items: [] }, configFor(userA))).rejects.toThrow();
  });

  it('refuses to run without an authenticated user in config', async () => {
    await expect(
      getTool('add_expenses').invoke({ items: [{ title: 'x', amount: 5, category: 'Food' }] })
    ).rejects.toThrow(/authenticated user/);
  });
});

describe('user scoping', () => {
  it('never returns another user\'s expenses', async () => {
    const expenses = createExpenseService(database.collections);
    await expenses.addExpenses(userB, [
      { title: 'secret', category: 'Other', amountPaise: 999, spentOn: '2026-10-01' },
    ]);

    const raw = await getTool('get_expenses').invoke(
      { from: '2026-01-01', to: '2026-12-31' },
      configFor(userA)
    );
    expect(raw).not.toContain('secret');

    const listB = await expenses.listExpenses(userB, { from: '2026-01-01', to: '2026-12-31' });
    expect(listB.map((e) => e.title)).toEqual(['secret']);
  });

  it('rejects a reversed date range', async () => {
    await expect(
      getTool('get_expenses').invoke({ from: '2026-10-31', to: '2026-10-01' }, configFor(userA))
    ).rejects.toThrow();
  });
});

describe('resolveFormat', () => {
  it('asks on the web when no preference is saved', () => {
    expect(resolveFormat(null, 'web')).toEqual({ kind: 'ask' });
  });

  it('uses the saved preference on the web', () => {
    expect(resolveFormat('chart', 'web')).toEqual({ kind: 'use', format: 'chart' });
  });

  it('never asks on Telegram and falls back from chart to table', () => {
    expect(resolveFormat(null, 'telegram')).toEqual({ kind: 'use', format: 'table' });
    expect(resolveFormat('chart', 'telegram')).toEqual({ kind: 'use', format: 'table' });
    expect(resolveFormat('json', 'telegram')).toEqual({ kind: 'use', format: 'json' });
  });
});

describe('show_expenses human-in-the-loop', () => {
  /** Runs the real ToolNode inside a graph, driven by a scripted tool call. */
  function buildGraph() {
    const toolNode = new ToolNode(initTools(database.collections, TZ));
    return new StateGraph(MessagesAnnotation)
      .addNode('tools', toolNode)
      .addEdge('__start__', 'tools')
      .addEdge('tools', '__end__')
      .compile({ checkpointer: new MemorySaver() });
  }

  const showCall = () =>
    new AIMessage({
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          name: 'show_expenses',
          args: { from: '2026-01-01', to: '2099-12-31' },
        },
      ],
    });

  it('pauses for a format choice, resumes, and saves the preference', async () => {
    const userId = await createTestUser(database, 'hitl@example.com');
    const graph = buildGraph();
    const config = { configurable: { thread_id: 'hitl', userId, channel: 'web' } };

    const paused = await graph.invoke({ messages: [showCall()] }, config);
    expect(interruptsOf(paused)?.[0].value).toMatchObject({ kind: 'format_picker' });

    const resumed = await graph.invoke(new Command({ resume: { format: 'json' } }), config);
    const result = JSON.parse(resumed.messages.at(-1)!.text);
    expect(result).toMatchObject({ type: 'expenses', format: 'json' });

    const users = createUserService(database.collections);
    expect(await users.getExpenseFormat(userId)).toBe('json');
  });

  it('skips the picker once a preference is saved', async () => {
    const userId = await createTestUser(database, 'pref@example.com');
    await createUserService(database.collections).setExpenseFormat(userId, 'table');

    const result = await buildGraph().invoke(
      { messages: [showCall()] },
      { configurable: { thread_id: 'pref', userId, channel: 'web' } }
    );
    expect(interruptsOf(result)).toBeUndefined();
    expect(JSON.parse(result.messages.at(-1)!.text).format).toBe('table');
  });

  it('can be cancelled without saving a preference', async () => {
    const userId = await createTestUser(database, 'cancel@example.com');
    const graph = buildGraph();
    const config = { configurable: { thread_id: 'cancel', userId, channel: 'web' } };

    await graph.invoke({ messages: [showCall()] }, config);
    const resumed = await graph.invoke(new Command({ resume: { cancelled: true } }), config);

    expect(JSON.parse(resumed.messages.at(-1)!.text)).toEqual({ type: 'cancelled' });
    expect(await createUserService(database.collections).getExpenseFormat(userId)).toBeNull();
  });
});

describe('tool schemas', () => {
  // JSON Schema keywords the Gemini function-calling API rejects
  const UNSUPPORTED = ['exclusiveMinimum', 'exclusiveMaximum', '$ref', 'oneOf', 'const'];

  it('only use JSON Schema features Gemini accepts', async () => {
    const { toJsonSchema } = await import('@langchain/core/utils/json_schema');
    for (const tool of initTools(database.collections, TZ)) {
      const json = JSON.stringify(toJsonSchema(tool.schema as never));
      for (const key of UNSUPPORTED) {
        expect(json, `${tool.name} uses ${key}`).not.toContain(`"${key}"`);
      }
    }
  });
});

describe('category filters and explicit formats', () => {
  let userId: string;

  beforeAll(async () => {
    userId = await createTestUser(database, 'categories@example.com');
    await createExpenseService(database.collections).addExpenses(userId, [
      { title: 'lunch', category: 'Food', amountPaise: 15000, spentOn: '2026-10-02' },
      { title: 'dinner', category: 'Food', amountPaise: 25000, spentOn: '2026-10-03' },
      { title: 'cab', category: 'Travel', amountPaise: 30000, spentOn: '2026-10-03' },
      { title: 'movie', category: 'Entertainment', amountPaise: 50000, spentOn: '2026-10-04' },
    ]);
  });

  const october = { from: '2026-10-01', to: '2026-10-31' };

  it('shows only the requested category in the requested format without asking', async () => {
    const raw = await getTool('show_expenses').invoke(
      { ...october, categories: ['Food'], format: 'table' },
      configFor(userId)
    );
    const result = JSON.parse(raw as string);
    expect(result.format).toBe('table');
    expect(result.expenses.map((e: { title: string }) => e.title)).toEqual(['lunch', 'dinner']);
    expect(result.summary).toMatchObject({ categories: ['Food'], totalPaise: 40000, count: 2 });
    // A one-off explicit format does not overwrite the saved preference
    expect(await createUserService(database.collections).getExpenseFormat(userId)).toBeNull();
  });

  it('handles several categories at once', async () => {
    const raw = await getTool('show_expenses').invoke(
      { ...october, categories: ['Food', 'Travel'], format: 'json' },
      configFor(userId)
    );
    const result = JSON.parse(raw as string);
    expect(result.summary.count).toBe(3);
    expect(result.summary.byCategory.map((c: { category: string }) => c.category)).toEqual(['Food', 'Travel']);
  });

  it('builds a category-only chart', async () => {
    const raw = await getTool('generate_expense_chart').invoke(
      { ...october, categories: ['Food'], groupBy: 'month' },
      configFor(userId)
    );
    expect(JSON.parse(raw as string)).toEqual({
      type: 'chart',
      data: [{ month: '2026-10', amount: 400 }],
      labelKey: 'month',
      categories: ['Food'],
    });
  });

  it('filters questions to a category', async () => {
    const raw = await getTool('get_expenses').invoke(
      { ...october, categories: ['Entertainment'] },
      configFor(userId)
    );
    expect(JSON.parse(raw as string)).toMatchObject({ total: 500, rows: [['2026-10-04', 'movie', 'Entertainment', 500]] });
  });

  it('rejects unknown categories', async () => {
    await expect(
      getTool('show_expenses').invoke({ ...october, categories: ['Snacks'] }, configFor(userId))
    ).rejects.toThrow();
  });

  it('an explicit format wins over the saved one; Telegram still cannot chart', () => {
    expect(resolveFormat('table', 'web', 'json')).toEqual({ kind: 'use', format: 'json' });
    expect(resolveFormat(null, 'web', 'chart')).toEqual({ kind: 'use', format: 'chart' });
    expect(resolveFormat(null, 'telegram', 'chart')).toEqual({ kind: 'use', format: 'table' });
    expect(resolveFormat(null, 'telegram', 'json')).toEqual({ kind: 'use', format: 'json' });
  });
});

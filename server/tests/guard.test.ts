import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from 'langchain';
import { isOffTopicRequest, isScopeRefusal, looksLikeCode, scopeRefusal } from '../guard.ts';
import { createAgent, runConfig, userMessage } from '../agent.ts';
import type { Database } from '../db.ts';
import { createTestUser, startTestDatabase } from './helpers.ts';

describe('isOffTopicRequest', () => {
  it('catches requests to write or fix code, in English and Hinglish', () => {
    for (const text of [
      'write a python code to reverse a string',
      'Write Java code for bubble sort',
      'give me a function in javascript',
      'python program for fibonacci',
      'code in c++ for linked list',
      'mujhe python code likh do',
      'ek java program banao',
      'fix this code error',
      'create a react app',
    ]) {
      expect(isOffTopicRequest(text), text).toBe(true);
    }
  });

  it('never blocks real expense messages that mention tech words', () => {
    for (const text of [
      'python course 5000',
      'java coffee 120',
      'bought react book 450',
      'udemy python course 499 aur chai 20',
      'tea 20, taxi 80',
      'show this month expenses',
      'analyse my spending',
      'is mahine ka hisaab dikhao',
      'how much did I spend on code academy subscription',
      'make a budget for food',
    ]) {
      expect(isOffTopicRequest(text), text).toBe(false);
    }
  });
});

describe('looksLikeCode', () => {
  it('detects code in a reply', () => {
    expect(looksLikeCode('Sure!\n```python\nprint("hi")\n```')).toBe(true);
    expect(looksLikeCode('def reverse(s):\n    return s[::-1]')).toBe(true);
    expect(looksLikeCode('public static void main(String[] args) {')).toBe(true);
  });

  it('leaves normal expense replies alone', () => {
    expect(looksLikeCode('✅ ₹100 added (Travel ₹80, Food ₹20)')).toBe(false);
    expect(looksLikeCode('- Food is 40% of your spending.\n- Try cooking at home.')).toBe(false);
  });
});

describe('agent scope enforcement', () => {
  let database: Database;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ database, stop } = await startTestDatabase());
  });
  afterAll(() => stop());

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
      return this.responses.shift() ?? new AIMessage('unexpected');
    }
  }

  function build(light: ScriptedModel) {
    return createAgent({
      collections: database.collections,
      checkpointer: new MemorySaver(),
      models: { light: light as unknown as BaseChatModel, mid: new ScriptedModel([]) as unknown as BaseChatModel },
      timeZone: 'Asia/Kolkata',
      historyMessages: 12,
    }).agent;
  }

  it('refuses a code request without calling the model', async () => {
    const userId = await createTestUser(database, 'scope-1@example.com');
    const light = new ScriptedModel([]);
    const result = await build(light).invoke(
      userMessage('write a python code to sort a list'),
      runConfig({ userId, channel: 'web', threadId: 'scope-1' })
    );
    expect(light.calls).toBe(0);
    expect(result.messages.at(-1)!.text).toBe(scopeRefusal('english'));
  });

  it('refuses in Hinglish for a Hinglish request', async () => {
    const userId = await createTestUser(database, 'scope-2@example.com');
    const result = await build(new ScriptedModel([])).invoke(
      userMessage('mujhe ek java program banao'),
      runConfig({ userId, channel: 'telegram', threadId: 'scope-2' })
    );
    expect(result.messages.at(-1)!.text).toBe(scopeRefusal('hinglish'));
  });

  it('replaces a model reply that contains code', async () => {
    const userId = await createTestUser(database, 'scope-3@example.com');
    const light = new ScriptedModel([new AIMessage('Here you go:\n```js\nconsole.log(1)\n```')]);
    const result = await build(light).invoke(
      userMessage('can you help me with something'),
      runConfig({ userId, channel: 'web', threadId: 'scope-3' })
    );
    expect(light.calls).toBe(1);
    expect(result.messages.at(-1)!.text).toBe(scopeRefusal('english'));
  });
});

describe('isScopeRefusal', () => {
  it('recognises the model writing its own refusal in either language', () => {
    expect(isScopeRefusal('I can only help with your expenses: logging them.')).toBe(true);
    expect(isScopeRefusal('Main sirf aapke kharche mein madad kar sakta hoon.')).toBe(true);
    expect(isScopeRefusal('✅ ₹150 added (Food ₹150)')).toBe(false);
  });
});

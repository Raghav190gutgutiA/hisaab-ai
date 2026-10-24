import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from 'langchain';
import { compactHistory } from '../agent.ts';
import { handleEmptyResponse, userFacingError } from '../llm.ts';

describe('Gemini error handling', () => {
  it('retries a malformed tool call once, then gives up', () => {
    expect(handleEmptyResponse('MALFORMED_FUNCTION_CALL', 0)).toEqual({ action: 'retry' });
    expect(handleEmptyResponse('MALFORMED_FUNCTION_CALL', 1).action).toBe('reply');
  });

  it('does not retry safety blocks', () => {
    const result = handleEmptyResponse('SAFETY', 0);
    expect(result.action).toBe('reply');
  });

  it('maps rate limits and outages to friendly messages', () => {
    expect(userFacingError(Object.assign(new Error('x'), { status: 429 }))).toMatch(/too many requests/);
    expect(userFacingError(new Error('[429 Too Many Requests] RESOURCE_EXHAUSTED'))).toMatch(/too many/);
    expect(userFacingError(Object.assign(new Error('x'), { status: 503 }))).toMatch(/temporarily unavailable/);
    expect(userFacingError(Object.assign(new Error('x'), { status: 402 }))).toMatch(/out of credits/);
    expect(userFacingError(new Error('boom'))).toMatch(/Something went wrong/);
  });
});

describe('compactHistory', () => {
  it('shrinks old tool results but keeps the current turn intact', () => {
    const big = JSON.stringify({
      type: 'expenses',
      expenses: Array.from({ length: 50 }, (_, i) => ({ title: `item ${i}` })),
      summary: { count: 50, totalPaise: 500000 },
    });
    const call = (id: string) =>
      new AIMessage({ content: '', tool_calls: [{ id, name: 'show_expenses', args: {} }] });

    const messages = [
      new HumanMessage('old'),
      call('1'),
      new ToolMessage({ content: big, tool_call_id: '1', name: 'show_expenses' }),
      new HumanMessage('new'),
      call('2'),
      new ToolMessage({ content: big, tool_call_id: '2', name: 'show_expenses' }),
    ];

    const compacted = compactHistory(messages);
    const old = JSON.parse(compacted[2].text);
    expect(old).toMatchObject({ type: 'expenses', count: 50, total: '₹5,000' });
    expect(compacted[2].text.length).toBeLessThan(200);
    expect((compacted[2] as ToolMessage).tool_call_id).toBe('1');
    expect(compacted[5].text).toBe(big);
  });
});

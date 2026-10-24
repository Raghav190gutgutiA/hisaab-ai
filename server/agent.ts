import type {
  BaseCheckpointSaver,
  LangGraphRunnableConfig,
} from '@langchain/langgraph';
import {
  Command,
  MessagesAnnotation,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { trimMessages, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage } from 'langchain';
import { initTools } from './tools.ts';
import { isOffTopicRequest, isScopeRefusal, looksLikeCode, scopeRefusal } from './guard.ts';
import type { Collections } from './db.ts';
import { todayIn } from './dates.ts';
import { formatPaise } from './money.ts';
import { CATEGORIES, describeCategoryTotals } from './services/expenses.ts';
import {
  addedText,
  cancelledText,
  chartText,
  detectLanguage,
  expensesText,
  budgetAlertText,
  budgetStatusText,
  noBudgetText,
  type ReplyLanguage,
} from './language.ts';
import {
  EmptyContentError,
  getFinishReason,
  handleEmptyResponse,
  isEmptyResponse,
  FALLBACK_REPLY,
  type ModelTier,
} from './llm.ts';
import type { Channel, StreamMessage } from './types.ts';

type AgentState = typeof MessagesAnnotation.State;

/** Tool results that are rendered as UI and end the run without another LLM call. */
const TERMINAL_RESULT_TYPES = new Set([
  'chart',
  'expenses',
  'expenses_added',
  'budget',
  'cancelled',
]);

export type AgentDeps = {
  collections: Collections;
  checkpointer: BaseCheckpointSaver;
  /** light: tool selection, logging, chat · mid: UI content + validation fallback */
  models: Record<ModelTier, BaseChatModel>;
  timeZone: string;
  historyMessages: number;
};

export type RunContext = {
  userId: string;
  channel: Channel;
  threadId: string;
};

export function runConfig(ctx: RunContext) {
  return {
    configurable: {
      thread_id: ctx.threadId,
      userId: ctx.userId,
      channel: ctx.channel,
    },
  };
}

export function parseToolResult(
  message: BaseMessage
): Record<string, any> | null {
  try {
    const parsed = JSON.parse(message.text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Older tool results are replaced with a one-line summary before being
 * sent to the model, so long expense lists are not re-sent every turn.
 */
export function compactHistory(messages: BaseMessage[]): BaseMessage[] {
  const lastHumanIndex = messages.findLastIndex(
    (m) => m.type === 'human'
  );

  return messages.map((message, index) => {
    if (
      index > lastHumanIndex ||
      message.type !== 'tool' ||
      message.text.length < 300
    ) {
      return message;
    }
    const result = parseToolResult(message);
    const tool = message as ToolMessage;
    return new ToolMessage({
      content: JSON.stringify({
        type: result?.type ?? 'unknown',
        note: 'Result shown to the user earlier; details omitted.',
        ...(typeof result?.summary === 'string' && {
          summary: result.summary,
        }),
        ...(result?.summary?.totalPaise !== undefined && {
          count: result.summary.count,
          total: formatPaise(result.summary.totalPaise),
        }),
        ...(result?.type === 'analysis' && {
          count: result.count,
          total: formatPaise(result.totalPaise),
        }),
      }),
      tool_call_id: tool.tool_call_id,
      name: tool.name,
    });
  });
}

function systemPrompt(timeZone: string, channel: Channel) {
  return `You are Hisaab.ai, a friendly expense tracking assistant. Reply briefly, in the user's language: English if they write English, Hinglish (Hindi in Roman script) if they write Hinglish.
SCOPE: you ONLY help with the user's own expenses in Hisaab.ai: logging, viewing, analysing, and budgeting tips about their spending. For anything else (writing or explaining code in any language, general knowledge, news, people, homework, maths unrelated to their expenses, jokes, stories, other apps) do not answer it at all, not even partly. Instead reply only with: "I can only help with your expenses: logging them, showing your spending and analysing it." (in Hinglish: "Main sirf aapke kharche mein madad kar sakta hoon: expense add karna, hisaab dekhna aur analysis."). Never output code.
Today is ${todayIn(timeZone)} (${timeZone}). Amounts are in rupees (₹). Categories: ${CATEGORIES.join(', ')}.
Tools:
- set_budget / get_budget_status: set or check the monthly budget ("mera budget 20000 set karo", "budget kitna bacha?"). Budgets are part of expense tracking.
- add_expenses: log expenses. Put every item from one message into one call. Keep repeated items as separate entries ("momos 200, momos 200" is two expenses); never merge or drop them.
- show_expenses: when the user wants to see/list their expenses (e.g. "show today's expenses", "is mahine ka hisaab"). Pass categories to filter (e.g. "food ka table" -> categories ["Food"], format "table"; "food aur travel ka json" -> ["Food","Travel"], "json"). Pass format only if the user names table, JSON or chart.
- generate_expense_chart: for weekly or monthly charts, optionally with categories.
- get_expenses: when you need data to answer a single question (a total, one biggest spend), optionally with categories.
- analyze_expenses: for analysis, insights, breakdowns, trends or comparisons of one category, several, or all. The user already sees the numbers as a card, so reply with 3-5 short bullet insights (biggest category, change vs previous period, unusual spends, one practical tip). Amounts in the tool result ending in Paise are paise: divide by 100 for rupees.
For "<category> ka chart" without a week/month grouping, use show_expenses with format "chart".${channel === 'telegram' ? `
You are on Telegram: write plain natural sentences only. Never use tables, JSON, code blocks or markdown. For analysis, write the insights as 2-4 short sentences instead of bullets.` : ''}
If an amount is missing or unclear, ask instead of guessing. Never invent expenses.`;
}

/**
 * Short reply added after a terminal tool so the history stays well-formed,
 * in the same language the user wrote in.
 */
export function terminalReply(
  result: Record<string, any>,
  language: ReplyLanguage = 'english'
): string {
  switch (result.type) {
    case 'expenses_added': {
      const added = `✅ ${addedText(language, result.totalPaise, describeCategoryTotals(result.byCategory))}`;
      const alert = result.budgetAlert;
      return alert ? `${added}\n\n${budgetAlertText(language, alert.level, alert.status)}` : added;
    }
    case 'budget':
      if (result.action === 'cleared') {
        return language === 'hinglish' ? 'Theek hai, monthly budget hata diya.' : 'Done, your monthly budget is removed.';
      }
      if (!result.status) return noBudgetText(language);
      return `${result.action === 'set' ? '✅ ' : ''}${budgetStatusText(language, result.status)}`;
    case 'expenses':
      return expensesText(language, result.summary);
    case 'chart':
      return chartText(language, result.categories ?? []);
    default:
      return cancelledText(language);
  }
}

/** Tool results whose follow-up text is generated UI content. */
const MID_TIER_RESULT_TYPES = new Set(['analysis']);

export type TierDecision = { tier: ModelTier; reason: string };

/**
 * Picks the cheapest model that can handle the next step:
 * - mid when the last tool call failed validation (the light model got the
 *   arguments wrong, so retry with the stronger model)
 * - mid when the step writes generated UI content (analysis insights)
 * - light for everything else: tool selection, logging and chat replies
 */
export function pickTier(messages: BaseMessage[]): TierDecision {
  const trailing: BaseMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].type === 'tool'; i--) {
    trailing.push(messages[i]);
  }

  const failed = trailing.some(
    (m) => (m as ToolMessage).status === 'error' || m.text.startsWith('Error')
  );
  if (failed) return { tier: 'mid', reason: 'tool-validation-failed' };

  const generatesUi = trailing.some((m) =>
    MID_TIER_RESULT_TYPES.has(parseToolResult(m)?.type)
  );
  if (generatesUi) return { tier: 'mid', reason: 'ui-content' };

  return { tier: 'light', reason: 'default' };
}

export function createAgent(deps: AgentDeps) {
  const tools = initTools(deps.collections, deps.timeZone);
  const toolNode = new ToolNode(tools);
  const boundModels = {
    light: deps.models.light.bindTools!(tools),
    mid: deps.models.mid.bindTools!(tools),
  };

  /**
   * Call model node
   */
  async function callModel(
    state: AgentState,
    config: LangGraphRunnableConfig
  ) {
    const channel: Channel = config.configurable?.channel ?? 'web';
    const history = await trimMessages(state.messages, {
      maxTokens: deps.historyMessages,
      tokenCounter: (messages) => messages.length,
      strategy: 'last',
      startOn: 'human',
    });

    // Clear off-topic requests (e.g. "write Python code") are refused without calling the model
    const lastMessage = state.messages.at(-1);
    if (lastMessage?.type === 'human' && isOffTopicRequest(lastMessage.text)) {
      return { messages: [new AIMessage(scopeRefusal(detectLanguage(lastMessage.text)))] };
    }

    const prompt = [
      { role: 'system', content: systemPrompt(deps.timeZone, channel) },
      ...compactHistory(history),
    ];

    let { tier, reason: routeReason } = pickTier(state.messages);

    for (let attempt = 0; attempt < 2; attempt++) {
      let response: AIMessage | undefined;
      let reason: string | undefined;
      console.info(`[llm] tier=${tier} reason=${routeReason}`);

      try {
        response = (await boundModels[tier].invoke(prompt)) as AIMessage;
        if (!isEmptyResponse(response)) {
          // Backstop: a text reply containing code is replaced with the scope refusal
          if (!response.tool_calls?.length && (looksLikeCode(response.text) || isScopeRefusal(response.text))) {
            const lastHuman = state.messages.findLast((m) => m.type === 'human');
            return { messages: [new AIMessage(scopeRefusal(detectLanguage(lastHuman?.text ?? '')))] };
          }
          return { messages: [response] };
        }
        reason = getFinishReason(response);
      } catch (error) {
        if (!EmptyContentError.isInstance(error)) throw error;
        reason = getFinishReason(error);
      }

      const next = handleEmptyResponse(reason, attempt, tier);
      if (next.action === 'reply') {
        return { messages: [new AIMessage(next.text)] };
      }
      // Escalate: a malformed call from the light model is retried on mid
      console.warn(`Gemini (${tier}) returned ${reason}, retrying on mid tier`);
      tier = 'mid';
      routeReason = `fallback-${reason?.toLowerCase() ?? 'empty'}`;
    }

    return { messages: [new AIMessage(FALLBACK_REPLY)] };
  }

  /**
   * Conditional edge
   */
  function shouldContinue(
    state: AgentState,
    config: LangGraphRunnableConfig
  ) {
    const lastMessage = state.messages.at(-1) as AIMessage;

    if (lastMessage.tool_calls?.length) {
      // send custom event
      for (const toolCall of lastMessage.tool_calls) {
        const customMessage: StreamMessage = {
          type: 'toolCall:start',
          payload: { name: toolCall.name, args: toolCall.args },
        };
        config.writer?.(customMessage);
      }
      return 'tools';
    }

    return '__end__';
  }

  function trailingToolResults(state: AgentState) {
    const results: Record<string, any>[] = [];
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const message = state.messages[i];
      if (message.type !== 'tool') break;
      results.unshift(parseToolResult(message) ?? {});
    }
    return results;
  }

  function shouldCallModel(state: AgentState) {
    const results = trailingToolResults(state);
    const allTerminal =
      results.length > 0 &&
      results.every((r) => TERMINAL_RESULT_TYPES.has(r.type));

    return allTerminal ? 'finalize' : 'callModel';
  }

  /**
   * Closes a run that ended on a UI-rendering tool with a short
   * deterministic message, saving an LLM round trip.
   */
  function finalize(state: AgentState) {
    const lastHuman = state.messages.findLast((m) => m.type === 'human');
    const language = detectLanguage(lastHuman?.text ?? '');
    const text = trailingToolResults(state)
      .map((result) => terminalReply(result, language))
      .join('\n');
    return { messages: [new AIMessage(text)] };
  }

  /**
   * Graph
   */
  const graph = new StateGraph(MessagesAnnotation)
    .addNode('callModel', callModel)
    .addNode('tools', toolNode)
    .addNode('finalize', finalize)
    .addEdge('__start__', 'callModel')
    .addConditionalEdges('callModel', shouldContinue, {
      __end__: '__end__',
      tools: 'tools',
    })
    .addConditionalEdges('tools', shouldCallModel, {
      callModel: 'callModel',
      finalize: 'finalize',
    })
    .addEdge('finalize', '__end__');

  const agent = graph.compile({ checkpointer: deps.checkpointer });

  /**
   * If the thread is paused on a format picker and the user sends a new
   * message instead, close the pending tool call so the history stays valid.
   */
  async function cancelPendingInterrupt(ctx: RunContext) {
    const state = await agent.getState(runConfig(ctx));
    const pending = state.tasks.some((task) => task.interrupts.length > 0);
    if (pending) {
      await agent.invoke(
        new Command({ resume: { cancelled: true } }),
        runConfig(ctx)
      );
    }
  }

  async function getPendingInterrupt(ctx: RunContext) {
    const state = await agent.getState(runConfig(ctx));
    for (const task of state.tasks) {
      if (task.interrupts.length) return task.interrupts[0].value;
    }
    return null;
  }

  /**
   * Non-streaming run used by Telegram. Returns only the messages
   * produced in this turn.
   */
  async function runTurn(ctx: RunContext, text: string): Promise<BaseMessage[]> {
    await cancelPendingInterrupt(ctx);
    const before = await agent.getState(runConfig(ctx));
    const previousCount = before.values.messages?.length ?? 0;
    const result = await agent.invoke(userMessage(text), runConfig(ctx));
    return result.messages.slice(previousCount);
  }

  return { agent, cancelPendingInterrupt, getPendingInterrupt, runTurn };
}

export type Agent = ReturnType<typeof createAgent>;

export function userMessage(text: string) {
  return { messages: [new HumanMessage(text)] };
}

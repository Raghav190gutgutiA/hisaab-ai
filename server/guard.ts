import type { ReplyLanguage } from './language.ts';

/**
 * Hisaab.ai only talks about the user's expenses. These checks keep it on
 * topic without spending tokens: obvious off-topic requests are refused
 * before the model is called, and replies that contain code are replaced.
 * Subtler off-topic questions are handled by the scope rule in the prompt.
 */

const LANGUAGES =
  'python|java|javascript|typescript|js|ts|c\\+\\+|cpp|c#|csharp|golang|go|rust|ruby|php|kotlin|swift|sql|html|css|bash|shell|react|node|dart|scala|perl|matlab|r';

// "write/give/make ... code/program/script/function" or "... in python/java"
const CODE_REQUEST = new RegExp(
  [
    `\\b(write|give|make|create|generate|build|show|likh|likho|bana|banao|bata|batao|de|do)\\b.{0,40}\\b(code|program|programme|script|function|class|algorithm|snippet|query|regex|api|website|app)\\b`,
    // (?!\w) instead of \b, so names ending in a symbol (c++, c#) also match
    `\\b(code|program|script|function|snippet)\\b.{0,30}\\b(in|using|mein|me)\\s+(${LANGUAGES})(?!\\w)`,
    `\\b(${LANGUAGES})\\s+(code|program|script|function|snippet)\\b`,
    `\\b(debug|fix|refactor|compile)\\b.{0,20}\\b(code|program|script|bug|error)\\b`,
  ].join('|'),
  'i'
);

/** True for requests that are clearly about writing or fixing code. */
export function isOffTopicRequest(text: string): boolean {
  return CODE_REQUEST.test(text);
}

/** True when a reply contains code instead of an expense answer. */
export function looksLikeCode(text: string): boolean {
  return (
    /```/.test(text) ||
    /^\s*(def |class |import |from \w+ import |public (static )?(void|class)|function \w+\(|const \w+ = \(|#include|console\.log\(|System\.out\.print|print\()/m.test(
      text
    )
  );
}

export function scopeRefusal(language: ReplyLanguage): string {
  return language === 'hinglish'
    ? 'Main sirf aapke kharche mein madad kar sakta hoon: expense add karna, hisaab dekhna aur analysis. Jaise: "chai 20, auto 80" ya "is mahine ka hisaab dikhao".'
    : 'I can only help with your expenses: logging them, showing your spending and analysing it. Try "tea 20, taxi 80" or "show this month\'s expenses".';
}

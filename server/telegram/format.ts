import { formatPaise } from '../money.ts';
import { addedText, type ReplyLanguage } from '../language.ts';
import {
  describeCategories,
  describeCategoryTotals,
  type Expense,
  type ExpenseSummary,
} from '../services/expenses.ts';
import type { ExpenseAnalysis } from '../services/analysis.ts';
import type { ExpensesAddedResult } from '../types.ts';

/**
 * Telegram replies are written as natural sentences only: no tables, no
 * JSON blocks and no format buttons. Charts and tables live on the web.
 */

// How many individual expenses to name before summarising the rest
const MAX_LISTED = 8;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** "✅ ₹100 added (Food ₹20, Travel ₹80)" */
export function formatAddedConfirmation(
  result: ExpensesAddedResult,
  language: ReplyLanguage = 'english'
): string {
  return `✅ ${addedText(language, result.totalPaise, describeCategoryTotals(result.byCategory))}`;
}

function formatShortDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatRange({ from, to }: { from: string; to: string }): string {
  return from === to ? formatShortDate(from) : `${formatShortDate(from)} – ${formatShortDate(to)}`;
}

/** "a, b and c" / "a, b aur c" */
function joinList(items: string[], language: ReplyLanguage): string {
  if (items.length <= 1) return items.join('');
  const and = language === 'hinglish' ? 'aur' : 'and';
  return `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * An expense list as a short paragraph: total, category split, the biggest
 * spend and the individual items (newest first), then a dashboard link.
 */
export function describeExpenses(
  expenses: Expense[],
  summary: ExpenseSummary,
  language: ReplyLanguage,
  dashboardUrl: string
): string {
  const hi = language === 'hinglish';
  const scope = describeCategories(summary.categories);
  const range = formatRange(summary);

  if (summary.count === 0) {
    return hi
      ? `${range} ke beech ${scope ? `${escapeHtml(scope)} ka ` : ''}koi expense nahi mila.`
      : `No ${scope ? `${escapeHtml(scope)} ` : ''}expenses between ${range}.`;
  }

  const total = `<b>${formatPaise(summary.totalPaise)}</b>`;
  const split = escapeHtml(describeCategoryTotals(summary.byCategory));
  const biggest = expenses.reduce((a, b) => (b.amountPaise > a.amountPaise ? b : a));
  const recent = [...expenses].reverse();
  const named = recent
    .slice(0, MAX_LISTED)
    .map((e) => `${escapeHtml(e.title)} ${formatPaise(e.amountPaise)} (${formatShortDate(e.spentOn)})`);
  const rest = recent.length - named.length;

  const sentences = hi
    ? [
        `${range} mein aapne ${scope ? `${escapeHtml(scope)} pe ` : ''}${total} kharch kiye, ${plural(summary.count, 'expense')} mein${summary.byCategory.length > 1 ? `: ${split}` : ''}.`,
        summary.count > 1 &&
          `Sabse bada kharcha ${escapeHtml(biggest.title)} ${formatPaise(biggest.amountPaise)} (${formatShortDate(biggest.spentOn)}) tha.`,
        `Expenses: ${named.join(', ')}${rest > 0 ? `, aur ${rest} aur` : ''}.`,
        `📊 Charts aur table ke liye web dashboard dekho: ${escapeHtml(dashboardUrl)}`,
      ]
    : [
        `You spent ${total}${scope ? ` on ${escapeHtml(scope)}` : ''} between ${range}, across ${plural(summary.count, 'expense')}${summary.byCategory.length > 1 ? `: ${split}` : ''}.`,
        summary.count > 1 &&
          `Your biggest spend was ${escapeHtml(biggest.title)} at ${formatPaise(biggest.amountPaise)} on ${formatShortDate(biggest.spentOn)}.`,
        `${summary.count === 1 ? 'It was' : 'They were'}: ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`,
        `📊 For charts and tables, open the web dashboard: ${escapeHtml(dashboardUrl)}`,
      ];

  return sentences.filter(Boolean).join('\n\n');
}

/**
 * The analysis numbers as a short paragraph. The model's insights are sent
 * right after it.
 */
export function describeAnalysis(analysis: ExpenseAnalysis, language: ReplyLanguage): string {
  const hi = language === 'hinglish';
  const scope = analysis.categories.length ? escapeHtml(analysis.categories.join(' & ')) : null;
  const range = formatRange(analysis);

  if (analysis.count === 0) {
    return hi
      ? `${range} ke beech ${scope ? `${scope} ka ` : ''}koi expense nahi mila, isliye analysis ke liye kuch nahi hai.`
      : `There were no ${scope ? `${scope} ` : ''}expenses between ${range}, so there's nothing to analyse yet.`;
  }

  const total = `<b>${formatPaise(analysis.totalPaise)}</b>`;
  const perDay = formatPaise(analysis.avgPerDayPaise);
  const change = analysis.previous.changePct;
  const previousTotal = formatPaise(analysis.previous.totalPaise);
  const shares = analysis.byCategory
    .slice(0, 3)
    .map((c) => `${c.category} ${c.sharePct}% (${formatPaise(c.totalPaise)})`);
  const top = analysis.topExpenses[0];
  const topText = `${escapeHtml(top.title)} ${formatPaise(top.amountPaise)} (${formatShortDate(top.spentOn)})`;

  const sentences = hi
    ? [
        `${range} mein aapne ${scope ? `${scope} pe ` : ''}${total} kharch kiye, ${plural(analysis.count, 'expense')} mein — roz lagbhag ${perDay}.`,
        change === null
          ? 'Pichle period mein koi kharcha nahi tha, isliye comparison nahi ho sakta.'
          : change === 0
            ? `Yeh pichle period (${previousTotal}) ke barabar hai.`
            : `Yeh pichle period (${previousTotal}) se ${Math.abs(change)}% ${change > 0 ? 'zyada' : 'kam'} hai.`,
        analysis.byCategory.length > 1 && `Category ke hisaab se: ${joinList(shares, language)}.`,
        `Sabse bada kharcha: ${topText}.`,
      ]
    : [
        `Between ${range} you spent ${total}${scope ? ` on ${scope}` : ''} across ${plural(analysis.count, 'expense')}, about ${perDay} a day.`,
        change === null
          ? 'There was no spending in the previous period to compare with.'
          : change === 0
            ? `That's the same as the previous period (${previousTotal}).`
            : `That's ${Math.abs(change)}% ${change > 0 ? 'more' : 'less'} than the previous period (${previousTotal}).`,
        analysis.byCategory.length > 1 && `By category: ${joinList(shares, language)}.`,
        `Your biggest single expense was ${topText}.`,
      ];

  return sentences.filter(Boolean).join(' ');
}

export const HELP_TEXT = `<b>Hisaab.ai</b> — log and view expenses by chatting.

<b>Log expenses</b>
<code>tea 20, taxi 80</code>
<code>groceries 450 yesterday</code>

<b>Ask about your spending</b>
<code>show today's expenses</code> · <code>this month's spending</code>
<code>how much did I spend on food?</code>

<b>Analysis</b>
<code>analyse my spending this month</code>
<code>food aur travel ka analysis</code>

<b>Commands</b>
/today — today's expenses
/month — this month's expenses
/link &lt;code&gt; — link this chat to your account
/help — this message

For tables and charts, use the web dashboard.`;

export function unlinkedText(webAppUrl: string): string {
  return `🔗 This chat isn't linked to a Hisaab.ai account yet.

1. Log in at ${escapeHtml(webAppUrl)}
2. Click <b>Connect Telegram</b>
3. Tap the link it opens, or send <code>/link &lt;code&gt;</code> here`;
}

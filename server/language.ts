import { formatPaise } from './money.ts';

export type ReplyLanguage = 'english' | 'hinglish';

// Words that almost only appear in Hinglish
const STRONG_MARKERS = new Set([
  'hai', 'hain', 'kya', 'kitna', 'kitne', 'kitni', 'dikhao', 'dikha', 'batao',
  'bata', 'banao', 'bana', 'kharcha', 'kharche', 'kharch', 'mahine', 'mahina',
  'hafte', 'hafta', 'aaj', 'kal', 'parso', 'mera', 'meri', 'mere', 'mujhe',
  'karo', 'kardo', 'hisaab', 'hisab', 'wala', 'wali', 'sirf', 'abhi', 'kaha',
  'kahan', 'kyun', 'nahi', 'haan', 'acha', 'accha', 'theek', 'jitna', 'kaisa',
]);

// Common Hinglish particles that are too short to trust on their own
const WEAK_MARKERS = new Set(['ka', 'ki', 'ke', 'ko', 'se', 'bhi', 'aur', 'mein', 'me', 'pe', 'tha', 'thi']);

/**
 * Cheap, token-free guess at whether the user wrote in Hinglish, used for
 * the fixed replies that are generated without calling the model.
 */
export function detectLanguage(text: string): ReplyLanguage {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  let weak = 0;
  for (const word of words) {
    if (STRONG_MARKERS.has(word)) return 'hinglish';
    if (WEAK_MARKERS.has(word)) weak++;
  }
  return weak >= 2 ? 'hinglish' : 'english';
}

/** "₹100 added (Travel ₹80, Food ₹20)" / "₹100 add ho gaya (...)" */
export function addedText(
  language: ReplyLanguage,
  totalPaise: number,
  breakdown: string
): string {
  return language === 'hinglish'
    ? `${formatPaise(totalPaise)} add ho gaya (${breakdown})`
    : `${formatPaise(totalPaise)} added (${breakdown})`;
}

export function expensesText(
  language: ReplyLanguage,
  summary: { from: string; to: string; categories: string[]; count: number; totalPaise: number }
): string {
  const { from, to, count, totalPaise } = summary;
  const category = summary.categories.length ? summary.categories.join(' & ') : null;
  const total = formatPaise(totalPaise);

  if (language === 'hinglish') {
    const what = category ? `${category} ka hisaab` : 'aapka hisaab';
    return count === 0
      ? `${from} se ${to} tak ${category ? `${category} ka ` : ''}koi expense nahi mila.`
      : `Yeh raha ${what} ${from} se ${to} tak: ${total}, ${count} ${count === 1 ? 'expense' : 'expenses'}.`;
  }

  const what = category ? `${category} expenses` : 'expenses';
  return count === 0
    ? `No ${category ? `${category} ` : ''}expenses found from ${from} to ${to}.`
    : `Here are your ${what} from ${from} to ${to}: ${total} across ${count} ${count === 1 ? 'expense' : 'expenses'}.`;
}

export function chartText(language: ReplyLanguage, categories: string[]): string {
  const category = categories.length ? categories.join(' & ') : null;
  if (language === 'hinglish') {
    return category ? `Yeh raha aapka ${category} ka chart.` : 'Yeh raha aapka expense chart.';
  }
  return category ? `Here's your ${category} expense chart.` : "Here's your expense chart.";
}

export function cancelledText(language: ReplyLanguage): string {
  return language === 'hinglish' ? 'Theek hai, cancel kar diya.' : 'Okay, cancelled.';
}

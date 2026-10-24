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

type BudgetNumbers = {
  month: string;
  budgetPaise: number;
  spentPaise: number;
  remainingPaise: number;
  usedPct: number;
  daysLeft: number;
  dailyAllowancePaise: number;
  topFlexible: { category: string; totalPaise: number } | null;
};

function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' });
}

const days = (n: number, hi: boolean) => (hi ? `${n} din` : `${n} ${n === 1 ? 'day' : 'days'}`);

/** Where to cut back: the biggest flexible category this month. */
function cutTip(status: BudgetNumbers, hi: boolean): string {
  if (!status.topFlexible) return '';
  const { category, totalPaise } = status.topFlexible;
  return hi
    ? ` Is mahine sabse zyada ${category} pe gaya (${formatPaise(totalPaise)}), wahi kam karna sabse aasaan hoga.`
    : ` ${category} is your biggest flexible spend this month (${formatPaise(totalPaise)}), so that's the easiest place to cut back.`;
}

/** Warning sent when spending first reaches 80% or 100% of the budget. */
export function budgetAlertText(language: ReplyLanguage, level: 80 | 100, status: BudgetNumbers): string {
  const hi = language === 'hinglish';
  const budget = formatPaise(status.budgetPaise);
  const spent = formatPaise(status.spentPaise);
  const month = monthName(status.month);

  if (level === 100) {
    const over = formatPaise(-status.remainingPaise);
    return hi
      ? `🚨 Aapka ${month} ka ${budget} budget cross ho gaya: ${spent} kharch ho chuke hain${status.remainingPaise < 0 ? ` (${over} zyada)` : ''}. Bache hue ${days(status.daysLeft, true)} sirf zaroori cheezon pe kharch karne ki koshish karein.${cutTip(status, true)}`
      : `🚨 You've crossed your ${budget} budget for ${month}: ${spent} spent${status.remainingPaise < 0 ? ` (${over} over)` : ''}. For the remaining ${days(status.daysLeft, false)}, try to stick to essentials.${cutTip(status, false)}`;
  }

  const left = formatPaise(status.remainingPaise);
  const perDay = formatPaise(status.dailyAllowancePaise);
  return hi
    ? `⚠️ ${month} ka ${Math.floor(status.usedPct)}% budget use ho gaya (${spent} / ${budget}). Ab ${days(status.daysLeft, true)} ke liye ${left} bache hain, yaani roz lagbhag ${perDay}.${cutTip(status, true)}`
    : `⚠️ You've used ${Math.floor(status.usedPct)}% of your ${budget} budget for ${month} (${spent}). ${left} is left for ${days(status.daysLeft, false)}, about ${perDay} a day.${cutTip(status, false)}`;
}

/** Budget status, e.g. after setting it or when the user asks. */
export function budgetStatusText(language: ReplyLanguage, status: BudgetNumbers): string {
  const hi = language === 'hinglish';
  const budget = formatPaise(status.budgetPaise);
  const spent = formatPaise(status.spentPaise);
  const month = monthName(status.month);
  const pct = Math.floor(status.usedPct);

  if (status.remainingPaise < 0) {
    const over = formatPaise(-status.remainingPaise);
    return hi
      ? `${month} ka budget ${budget} hai. Aap ${spent} kharch kar chuke hain, yaani ${over} zyada.${cutTip(status, true)}`
      : `Your ${month} budget is ${budget}. You've spent ${spent}, which is ${over} over.${cutTip(status, false)}`;
  }
  const left = formatPaise(status.remainingPaise);
  const perDay = formatPaise(status.dailyAllowancePaise);
  return hi
    ? `${month} ka budget ${budget} hai. ${spent} kharch hua (${pct}%), ${left} bache hain: ${days(status.daysLeft, true)} ke liye roz lagbhag ${perDay}.`
    : `Your ${month} budget is ${budget}. You've spent ${spent} (${pct}%), with ${left} left: about ${perDay} a day for the next ${days(status.daysLeft, false)}.`;
}

export function noBudgetText(language: ReplyLanguage): string {
  return language === 'hinglish'
    ? 'Abhi koi monthly budget set nahi hai. Set karne ke liye likhein: "mera monthly budget 20000 set karo".'
    : 'You have no monthly budget yet. Set one with: "set my monthly budget to 20000".';
}

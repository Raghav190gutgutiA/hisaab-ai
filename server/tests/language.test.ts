import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../language.ts';
import { terminalReply } from '../agent.ts';

describe('detectLanguage', () => {
  it('recognises Hinglish', () => {
    for (const text of [
      'is mahine ka hisaab dikhao',
      'aaj ka kharcha',
      'food ka chart banao',
      'kitna spend kiya',
      'mera food aur travel ka table',
    ]) {
      expect(detectLanguage(text), text).toBe('hinglish');
    }
  });

  it('keeps plain English as English', () => {
    for (const text of [
      'show this month expenses',
      'tea 20, taxi 80',
      'make a food chart',
      'show food and travel as JSON',
      'how much did I spend on rent?',
    ]) {
      expect(detectLanguage(text), text).toBe('english');
    }
  });
});

describe('terminalReply', () => {
  const summary = {
    from: '2026-10-01',
    to: '2026-10-31',
    categories: ['Food'],
    count: 2,
    totalPaise: 15000,
    byCategory: [],
  };

  it('answers in English or Hinglish and names the categories', () => {
    expect(terminalReply({ type: 'expenses', summary }, 'english')).toBe(
      'Here are your Food expenses from 2026-10-01 to 2026-10-31: ₹150 across 2 expenses.'
    );
    expect(terminalReply({ type: 'expenses', summary }, 'hinglish')).toBe(
      'Yeh raha Food ka hisaab 2026-10-01 se 2026-10-31 tak: ₹150, 2 expenses.'
    );
    expect(terminalReply({ type: 'chart', categories: ['Food', 'Travel'] }, 'hinglish')).toBe(
      'Yeh raha aapka Food & Travel ka chart.'
    );
    expect(terminalReply({ type: 'cancelled' }, 'hinglish')).toBe('Theek hai, cancel kar diya.');
  });

  it('handles an empty category list', () => {
    expect(
      terminalReply({ type: 'expenses', summary: { ...summary, count: 0, totalPaise: 0 } }, 'english')
    ).toBe('No Food expenses found from 2026-10-01 to 2026-10-31.');
  });
});

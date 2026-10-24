import { describe, expect, it } from 'vitest';
import { formatPaise, rupeesToPaise } from '../money.ts';
import { monthRange, todayIn } from '../dates.ts';

describe('money', () => {
  it('converts rupees to integer paise without float drift', () => {
    expect(rupeesToPaise(20)).toBe(2000);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
    expect(rupeesToPaise(149.99)).toBe(14999);
    expect(Number.isInteger(rupeesToPaise(19.995))).toBe(true);
  });

  it('rejects non-finite amounts', () => {
    expect(() => rupeesToPaise(Number.NaN)).toThrow();
    expect(() => rupeesToPaise(Infinity)).toThrow();
  });

  it('formats paise as Indian rupees', () => {
    expect(formatPaise(2000)).toBe('₹20');
    expect(formatPaise(12050)).toBe('₹120.5');
    expect(formatPaise(12345600)).toBe('₹1,23,456');
  });
});

describe('dates', () => {
  it('uses the app timezone for "today"', () => {
    // 20:00 UTC on 31 Oct is already 1 Nov in India
    const now = new Date('2026-10-31T20:00:00Z');
    expect(todayIn('Asia/Kolkata', now)).toBe('2026-11-01');
    expect(todayIn('UTC', now)).toBe('2026-10-31');
  });

  it('computes the full current month', () => {
    expect(monthRange('Asia/Kolkata', new Date('2026-02-10T00:00:00Z'))).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });
});

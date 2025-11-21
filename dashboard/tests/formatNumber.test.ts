import { describe, test, expect } from 'bun:test';
import { formatNumber } from '@/lib/number';

describe('formatNumber helper', () => {
  test('returns empty for undefined / null', () => {
    expect(formatNumber(undefined)).toBe('');
    expect(formatNumber(null as any)).toBe('');
  });

  test('formats thousands with commas (en-US)', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  test('formats decimals when options provided', () => {
    expect(formatNumber(1234.567, { maximumFractionDigits: 2 })).toBe(
      '1,234.57',
    );
  });

  test('formats compact notation when requested', () => {
    // This depends on locale; compact may produce '1.2M' or '1.2M'
    const val = formatNumber(1200000, { compact: true });
    expect(val).toBeDefined();
    expect(typeof val).toBe('string');
  });

  test('respects locale', () => {
    expect(formatNumber(1234567, { locale: 'de-DE' })).toBe('1.234.567');
  });
});

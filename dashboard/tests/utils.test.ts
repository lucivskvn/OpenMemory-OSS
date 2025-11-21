import { describe, test, expect } from 'bun:test';
import { cn } from '@/lib/utils';

describe('utils: cn', () => {
  test('merges classes', () => {
    const merged = cn('foo', 'bar baz', {});
    expect(typeof merged).toBe('string');
    expect(merged).toContain('foo');
    expect(merged).toContain('bar');
  });
});

export {};

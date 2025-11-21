import { describe, test, expect } from 'bun:test';
import { badgeVariants } from '@/components/ui/badge';

describe('badgeVariants', () => {
  test('default variant includes primary classes', () => {
    const cls = badgeVariants({});
    expect(typeof cls).toBe('string');
    expect(cls).toContain('inline-flex');
    expect(cls).toContain('rounded-full');
  });

  test('secondary variant contains secondary class', () => {
    const cls = badgeVariants({ variant: 'secondary' });
    expect(cls).toContain('bg-secondary');
  });
});

export {};

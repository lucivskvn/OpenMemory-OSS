import { describe, it, expect } from 'bun:test';
import {
  hashPassword,
  verifyPassword,
  hashString,
  generateId,
  generateToken,
  isHashedKey,
  generateCSRFToken,
  verifyCSRFToken,
} from '../../backend/src/utils/crypto';

describe('crypto utils basic', () => {
  it('hash and verify password', async () => {
    const pw = 'correct horse battery staple';
    const h = await hashPassword(pw);
    expect(typeof h).toBe('string');
    expect(await verifyPassword(pw, h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('hashString produces deterministic hex', () => {
    const s = 'hello world';
    const a = hashString(s);
    const b = hashString(s);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('generateId and token', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    const t = generateToken(16);
    expect(typeof t).toBe('string');
    expect(t.length).toBe(32);
  });
});

describe('hashed key helpers and auth middleware', () => {
  it('isHashedKey recognizes argon2 and bcrypt hashes and rejects plaintext', () => {
    expect(
      isHashedKey('$argon2id$v=19$m=65536,t=2,p=1$SOMEBASE64$SOMEHASH'),
    ).toBe(true);
    expect(isHashedKey('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
    expect(isHashedKey('plain-secret-api-key')).toBe(false);
    expect(isHashedKey('')).toBe(false);
    expect(isHashedKey('$argon2brokenprefix')).toBe(false);
  });

  it('auth middleware rejects plaintext API key (returns 403 invalid_api_key)', async () => {
    const authMod = await import('../../backend/src/server/middleware/auth.ts');
    // Temporarily silence logger.error to avoid noisy stderr output from the
    // deliberate plaintext-key detection exercised by this test. We still
    // assert the middleware behavior (403) below.
    const logger = await import('../../backend/src/core/logger');
    let handle: any = null;
    const originalError = logger.default && logger.default.error;
    try {
      const { spyLoggerMethod } = await import('../utils/spyLoggerSafely');
      handle = spyLoggerMethod(logger, 'error', () => {
        /* noop */
      });

      // Inject a plaintext API key into the middleware seam
      authMod.setAuthApiKeyForTests('plain-secret-value');

      // Use POST method to ensure auth is checked (GET requests bypass auth)
      const req = new Request('http://localhost/test', {
        method: 'POST',
        headers: { 'x-api-key': 'plain-secret-value' },
      });

      const res = await authMod.authenticate_api_request(
        req as any,
        {} as any,
        async () => {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      );

      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toContain('invalid_api_key');
    } finally {
      // Reset seam and restore logger
      authMod.setAuthApiKeyForTests(undefined);
      try {
        if (handle && typeof handle.restore === 'function') handle.restore();
      } catch (e) {}
      try {
        if (originalError && logger.default)
          logger.default.error = originalError;
      } catch (_) {}
    }
  });
});

describe('CSRF helpers', () => {
  it('generateCSRFToken returns non-empty string with different values', () => {
    const token1 = generateCSRFToken();
    const token2 = generateCSRFToken();

    expect(typeof token1).toBe('string');
    expect(token1.length).toBeGreaterThan(0);
    expect(typeof token2).toBe('string');
    expect(token2.length).toBeGreaterThan(0);
    expect(token1).not.toBe(token2); // successive calls should produce different values
  });

  it('verifyCSRFToken returns true for identical tokens and false for different tokens', () => {
    const token = generateCSRFToken();

    // Same token should verify as true
    expect(verifyCSRFToken(token, token)).toBe(true);

    // Different token should verify as false
    const differentToken = generateCSRFToken();
    expect(verifyCSRFToken(token, differentToken)).toBe(false);

    // Wrong lengths should verify as false
    const shortToken = token.slice(0, 10);
    expect(verifyCSRFToken(token, shortToken)).toBe(false);

    // First character different should verify as false
    const firstCharModified = 'x' + token.slice(1);
    expect(verifyCSRFToken(token, firstCharModified)).toBe(false);

    // Last character different should verify as false
    const lastCharModified = token.slice(0, -1) + 'x';
    expect(verifyCSRFToken(token, lastCharModified)).toBe(false);
  });

  it('verifyCSRFToken does not short-circuit on first character mismatch (timing check)', async () => {
    const token = generateCSRFToken();

    // Create tokens of the same length with mismatches at different positions
    // Only test tokens with the same length to focus on timing attacks within the comparison loop
    const sameLengthTokens = [
      token, // valid token
      'x' + token.slice(1), // mismatch at position 0
      token.slice(0, 10) + 'x' + token.slice(11), // mismatch at position 10
      token.slice(0, -1) + 'x', // mismatch at last position
    ];

    const iterations = 1000; // Increase iterations for more reliable timing measurement
    const durations: number[] = [];

    // Measure time for each type of token
    for (const testToken of sameLengthTokens) {
      const measurements: number[] = [];
      for (let i = 0; i < 5; i++) {
        // Multiple measurements per token type
        const start = performance.now();
        for (let j = 0; j < iterations; j++) {
          verifyCSRFToken(token, testToken);
        }
        const end = performance.now();
        measurements.push(end - start);
      }
      // Use average of measurements for this token type
      durations.push(
        measurements.reduce((a, b) => a + b, 0) / measurements.length,
      );
    }

    // Check that duration variations are within reasonable bounds within the comparison loop
    const maxDuration = Math.max(...durations);
    const minDuration = Math.min(...durations);

    // The function should be timing-safe for equal-length tokens
    // Allow up to 5x variation in timing (generous threshold to account for system variability)
    const ratio = maxDuration / (minDuration || 1); // Avoid division by zero
    expect(
      ratio,
      'verifyCSRFToken should have consistent timing for equal-length tokens',
    ).toBeLessThan(5);
  });
});

// Coarse performance/regression checks.
// These are NOT precise benchmarks — they verify there are no large regressions
// in CI. If you need precise benchmarking run a dedicated harness locally.
describe('Performance', () => {
  it('hashString() and hashPassword() complete under generous thresholds', async () => {
    const iterations = 6; // keep CI time reasonable
    const input = 'The quick brown fox jumps over the lazy dog '.repeat(10);
    const pwd = 'S3cureP@ssw0rd!'.repeat(6);

    let totalHashString = 0;
    let totalHashPassword = 0;

    for (let i = 0; i < iterations; i++) {
      const t0 = Date.now();
      // synchronous fast hash
      hashString(input);
      totalHashString += Date.now() - t0;

      const t1 = Date.now();
      // hashPassword is async and may be slower; await it.
      // eslint-disable-next-line no-await-in-loop
      await hashPassword(pwd);
      totalHashPassword += Date.now() - t1;
    }

    const avgHashString = totalHashString / iterations;
    const avgHashPassword = totalHashPassword / iterations;

    // Conservative thresholds for CI machines. These are intentionally large
    // to avoid flaky failures on slower CI runners but still catch huge regressions.
    expect(avgHashString).toBeLessThan(150); // ms
    expect(avgHashPassword).toBeLessThan(1500); // ms
  });
});

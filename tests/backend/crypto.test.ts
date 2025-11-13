import { describe, it, expect } from 'bun:test';
import { hashPassword, verifyPassword, hashString, generateId, generateToken } from '../../backend/src/utils/crypto';

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
        const { isHashedKey } = require('../../backend/src/utils/crypto');
        expect(isHashedKey('$argon2id$v=19$m=65536,t=2,p=1$SOMEBASE64$SOMEHASH')).toBe(true);
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
        const originalError = logger.default.error;
        try {
            logger.default.error = () => { /* noop during this test */ } as any;

            // Inject a plaintext API key into the middleware seam
            authMod.setAuthApiKeyForTests('plain-secret-value');

            const req = new Request('http://localhost/test', { headers: { 'x-api-key': 'plain-secret-value' } });

            const res = await authMod.authenticate_api_request(req as any, {} as any, async () => {
                return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            });

            expect(res.status).toBe(403);
            const body = await res.text();
            expect(body).toContain('invalid_api_key');

        } finally {
            // Reset seam and restore logger
            authMod.setAuthApiKeyForTests(undefined);
            logger.default.error = originalError;
        }
    });
});

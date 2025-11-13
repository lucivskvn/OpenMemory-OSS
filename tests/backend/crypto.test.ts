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

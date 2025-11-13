import { describe, test, expect } from 'bun:test';

import loggerModule from '../../backend/src/core/logger';

describe('Auth middleware (auth.ts)', () => {
    test('auth middleware rejects plaintext API key (returns 403 invalid_api_key)', async () => {
        const authMod = await import('../../backend/src/server/middleware/auth');
        // Temporarily silence logger.error to avoid noisy stderr output
        const logger = (await import('../../backend/src/core/logger')).default;
        const originalError = logger.error;
        try {
            logger.error = () => { /* noop during test */ };

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
            logger.error = originalError;
        }
    });
});

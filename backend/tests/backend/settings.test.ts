import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { settings } from "../../src/server/routes/settings";

describe('Settings API', () => {
    let app: Elysia;

    beforeAll(() => {
        app = new Elysia();
        app.use(settings);
    });

    test('Get Settings', async () => {
        const res = await app.handle(new Request("http://localhost/api/settings"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('settings');
        // Check if sensitive keys are masked or missing
        // (Assuming tests run in env with some keys set)
        if (data.settings.OPENAI_API_KEY) {
             expect(data.settings.OPENAI_API_KEY).toBe("***");
        }
        // Also ensure generic secret-like keys are masked
        if (data.settings.MY_SECRET) expect(data.settings.MY_SECRET).toBe("***");
        if (data.settings.SOME_JWT) expect(data.settings.SOME_JWT).toBe("***");
    });

    test('POST Settings should not overwrite masked values and should add new keys', async () => {
        const fs = require('fs');
        const path = require('path');
        const envPath = path.resolve(process.cwd(), '.env');

        // Backup current .env if present
        let orig = undefined;
        if (fs.existsSync(envPath)) orig = fs.readFileSync(envPath, 'utf-8');

        try {
            // Write initial .env
            fs.writeFileSync(envPath, 'OPENAI_API_KEY=real_value\nEXISTING=old');

            const body = JSON.stringify({ OPENAI_API_KEY: '***', NEW_KEY: 'new_value' });
            const res = await app.handle(new Request('http://localhost/api/settings', { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
            expect(res.status).toBe(200);

            const newEnv = fs.readFileSync(envPath, 'utf-8');
            expect(newEnv).toContain('OPENAI_API_KEY=real_value');
            expect(newEnv).toContain('NEW_KEY=new_value');
        } finally {
            if (orig !== undefined) fs.writeFileSync(envPath, orig); else fs.unlinkSync(envPath);
        }
    });

    test('POST Settings should reject values with newlines', async () => {
        const path = require('path');
        const fs = require('fs');
        const envPath = path.resolve(process.cwd(), '.env');

        // Backup current .env if present
        let orig = undefined;
        if (fs.existsSync(envPath)) orig = fs.readFileSync(envPath, 'utf-8');

        try {
            if (fs.existsSync(envPath)) fs.unlinkSync(envPath);
            const body = JSON.stringify({ SAFE_KEY: 'ok', BAD_KEY: 'evil\nINJECT=1' });
            const res = await app.handle(new Request('http://localhost/api/settings', { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data).toHaveProperty('error','invalid_value');
        } finally {
            if (orig !== undefined) fs.writeFileSync(envPath, orig); else { if (fs.existsSync(envPath)) fs.unlinkSync(envPath); }
        }
    });

    test('GET Settings hides Postgres OM_PG_* when not using postgres metadata backend', async () => {
        // Set a bunch of envs for test
        process.env.OM_METADATA_BACKEND = 'sqlite';
        process.env.OM_PG_HOST = 'pg.local';
        process.env.OM_PG_USER = 'pguser';

        const res = await app.handle(new Request('http://localhost/api/settings'));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('settings');
        expect(data.settings).not.toHaveProperty('OM_PG_HOST');
        expect(data.settings).not.toHaveProperty('OM_PG_USER');

        // Cleanup
        delete process.env.OM_PG_HOST;
        delete process.env.OM_PG_USER;
        delete process.env.OM_METADATA_BACKEND;
    });

    test('GET Settings includes Postgres OM_PG_* when using postgres metadata backend', async () => {
        process.env.OM_METADATA_BACKEND = 'postgres';
        process.env.OM_PG_HOST = 'pg.local';
        process.env.OM_PG_USER = 'pguser';

        const res = await app.handle(new Request('http://localhost/api/settings'));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('settings');
        // Keys should exist but be masked if sensitive
        expect(data.settings).toHaveProperty('OM_PG_HOST');
        expect(data.settings.OM_PG_HOST).toBe('pg.local');

        // Cleanup
        delete process.env.OM_PG_HOST;
        delete process.env.OM_PG_USER;
        delete process.env.OM_METADATA_BACKEND;
    });
});

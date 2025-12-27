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
});

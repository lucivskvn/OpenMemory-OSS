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
});

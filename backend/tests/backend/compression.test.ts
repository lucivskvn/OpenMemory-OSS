import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { compression } from "../../src/server/routes/compression";
import { env } from "../../src/core/cfg";

// Force enable compression for testing
env.compression_enabled = true;

describe('Compression Real', () => {
    let app: Elysia;

    beforeAll(() => {
        console.log("Setting up Elysia app for compression test");
        app = new Elysia();
        console.log("App created", !!app);
        app.use(compression);
        console.log("Plugin used");
    });

    test('Compress Text', async () => {
        if (!app) throw new Error("App not initialized");
        const text = "This is a very very very long text that should be compressed by the engine.";
        const res = await app.handle(new Request("http://localhost/api/compression/compress", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content: text })
        }));

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('compressed');
        expect(data).toHaveProperty('metrics');
        expect(data.metrics.ogTok).toBeGreaterThan(0);
    });
});

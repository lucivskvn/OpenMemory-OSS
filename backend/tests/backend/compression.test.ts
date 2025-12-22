import { describe, test, expect } from "bun:test";

const BASE_URL = 'http://localhost:8080';
const API_KEY = 'your';

async function makeRequest(url: string, options: any = {}) {
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers: {
            ...options.headers,
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: options.body
    });
    let data;
    try {
        data = await res.json();
    } catch {
        data = {};
    }
    return {
        status: res.status,
        data,
        ok: res.ok
    };
}

describe('Compression Real', () => {
    test('Compress Text', async () => {
        const text = "This is a very very very long text that should be compressed by the engine.";
        const res = await makeRequest(`${BASE_URL}/compression/compress`, {
            method: 'POST',
            body: JSON.stringify({ content: text })
        });

        if (res.status === 404) {
            console.warn("Compression disabled, skipping");
            return;
        }

        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty('compressed');
        expect(res.data).toHaveProperty('metrics');
        expect(res.data.metrics.ogTok).toBeGreaterThan(0);
    });
});

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

describe('IDE Integration Real', () => {
    test('Store IDE Event', async () => {
        // Only works if IDE mode enabled (env.OM_IDE_MODE=true)
        // Default might be false.
        // But implementation checks env.ide_mode
        const res = await makeRequest(`${BASE_URL}/ide/events`, {
            method: 'POST',
            body: JSON.stringify({
                event: "file_save",
                metadata: { file: "test.ts" },
                session_id: "test-sess"
            })
        });

        if (res.status === 404) {
            console.warn("IDE mode disabled, skipping");
            return;
        }

        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty('ok', true);
        expect(res.data).toHaveProperty('id');
    });
});

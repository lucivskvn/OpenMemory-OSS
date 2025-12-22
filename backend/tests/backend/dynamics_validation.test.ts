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

describe('Dynamics Validation', () => {
    test('Resonance: Invalid Payload', async () => {
        const res = await makeRequest(`${BASE_URL}/dynamics/resonance`, {
            method: 'POST',
            body: JSON.stringify({
                source_sector: "semantic",
                // missing target_sector
            })
        });
        expect(res.status).toBe(400);
        expect(res.data.err).toBe("invalid_params");
    });

    test('Propagate: Invalid Payload', async () => {
        const res = await makeRequest(`${BASE_URL}/dynamics/propagate`, {
            method: 'POST',
            body: JSON.stringify({
                source_id: "123",
                reinforcement_value: "high" // should be number
            })
        });
        expect(res.status).toBe(400);
        expect(res.data.err).toBe("invalid_params");
    });
});

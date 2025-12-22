import { describe, test, expect } from "bun:test";

const BASE_URL = 'http://localhost:8080';
const API_KEY = 'your';

async function makeRequest(url: string, options: any = {}) {
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers: {
            ...options.headers,
            'Authorization': `Bearer ${API_KEY}`
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

describe('Dashboard API', () => {
    test('Get Stats', async () => {
        const res = await makeRequest(`${BASE_URL}/api/dashboard/stats`);
        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty('overview');
        expect(res.data.overview).toHaveProperty('total_memories');
    });

    test('Get Memories', async () => {
        const res = await makeRequest(`${BASE_URL}/api/dashboard/memories?limit=5`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.data.memories)).toBe(true);
    });
});

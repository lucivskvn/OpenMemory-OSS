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

describe("Temporal API", () => {
    test("Create Fact", async () => {
        const res = await makeRequest(`${BASE_URL}/temporal/fact`, {
            method: 'POST',
            body: JSON.stringify({
                subject: "User",
                predicate: "is_testing",
                object: "Temporal API",
                valid_from: Date.now()
            })
        });
        expect(res.status).toBe(200);
        expect(res.data).toHaveProperty('ok', true);
    });

    test("Get Facts", async () => {
        const res = await makeRequest(`${BASE_URL}/temporal/fact?subject=User`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.data.facts)).toBe(true);
    });
});

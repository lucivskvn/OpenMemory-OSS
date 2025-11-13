import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { extractURL } from "../../backend/src/ops/extract";

// Simple mock of fetch to avoid external network dependency
const originalFetch = globalThis.fetch;

beforeAll(() => {
    (globalThis as any).fetch = async (input: RequestInfo, init?: RequestInit) => {
        const body = `<html><body><h1>Test Page</h1><p>Hello from example.com</p></body></html>`;
        return new Response(body, { status: 200, headers: { "content-type": "text/html", "content-length": String(body.length) } });
    };
});

afterAll(() => {
    globalThis.fetch = originalFetch;
});

describe("extractURL", () => {
    it("extracts HTML and returns markdown and metadata with user_id", async () => {
        const url = "https://example.com/test";
        const userId = "user-test-123";
        const res = await extractURL(url, userId);
        expect(res).toBeTruthy();
        expect(res.metadata.content_type).toBe("url");
        expect(res.metadata.source_url).toBe(url);
        expect(res.text).toContain("Test Page");
        expect(res.metadata.estimated_tokens).toBeGreaterThan(0);
    });
});

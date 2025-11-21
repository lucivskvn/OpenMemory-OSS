import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { extractURL } from '../../backend/src/ops/extract';

// Simple mock of fetch to avoid external network dependency
const originalFetch = globalThis.fetch;

beforeAll(() => {
  (globalThis as any).fetch = async (
    input: RequestInfo,
    init?: RequestInit,
  ) => {
    const body = `<html><body><h1>Test Page</h1><p>Hello from example.com</p></body></html>`;
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-length': String(body.length),
      },
    });
  };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('extractURL', () => {
  it('extracts HTML and returns markdown and metadata with user_id', async () => {
    const url = 'https://example.com/test';
    const userId = 'user-test-123';
    const res = await extractURL(url, userId);
    expect(res).toBeTruthy();
    expect(res.metadata.content_type).toBe('url');
    expect(res.metadata.source_url).toBe(url);
    expect(res.text).toContain('Test Page');
    expect(res.metadata.estimated_tokens).toBeGreaterThan(0);
  });
});

describe('extractText multibyte handling', () => {
  it('computes char_count based on characters not bytes for UTF-8', async () => {
    const { extractText } = await import('../../backend/src/ops/extract');
    const sample = 'Hello café 🚀';
    // Sanity: JS string length should count surrogate pairs; expected length = 13
    expect(sample.length).toBe(13);
    const res = await extractText('text/plain', Buffer.from(sample, 'utf8'));
    expect(res).toBeTruthy();
    expect(res.metadata.char_count).toBe(sample.length);
    // estimated tokens use char_count -> > 0
    expect(res.metadata.estimated_tokens).toBeGreaterThan(0);
  });
});

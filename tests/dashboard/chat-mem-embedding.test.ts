import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

process.env.NEXT_PUBLIC_API_URL = 'http://localhost:8080';

describe('Dashboard mem endpoint embedding_mode', () => {
  let origFetch: any;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('sends embedding_mode to backend /memory/query and returns SSE', async () => {
    let capturedBody: any = null;

    // Mock fetch so when mem route calls memory/query we inspect the request
    globalThis.fetch = async (url: any, opts: any) => {
      if (typeof url === 'string' && url.endsWith('/memory/query')) {
        try {
          capturedBody = JSON.parse(opts.body);
        } catch (e) {
          capturedBody = null;
        }
        return {
          ok: true,
          json: async () => ({
            matches: [{ id: 'm1', content: 'hello', score: 0.9 }],
          }),
        };
      }
      // Fallback
      return { ok: false, json: async () => ({}) };
    };

    const memRoute: any = await import(
      '../../dashboard/app/api/chat/mem/route'
    );
    // Create a mock NextRequest shape with nextUrl
    const req: any = {
      nextUrl: new URL('http://localhost/?q=test&embedding_mode=router_cpu'),
    };
    const res: any = await memRoute.GET(req);
    expect(res).toBeTruthy();
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.metadata && capturedBody.metadata.embedding_mode).toBe(
      'router_cpu',
    );

    // Read stream from response (Response#text is available in bun fetch impl)
    const text = await res.text();
    expect(text.includes('event: memories')).toBeTruthy();
    expect(text.includes('m1')).toBeTruthy();
  });
});

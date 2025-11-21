import { describe, it, expect } from 'bun:test';
import { createServer } from '../../backend/src/server/server';
import { corsMiddleware } from '../../backend/src/server/index';

describe('CORS middleware and streaming opt-out', () => {
  it('does not merge CORS headers for handlers that set ctx.skipCors and stream', async () => {
    const app = createServer();
    app.use(corsMiddleware());

    app.get('/stream', async (_req, ctx) => {
      // Mark this handler as streaming so the CORS middleware skips merging
      ctx.skipCors = true;
      const rs = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: hello\n\n'));
          ctrl.close();
        },
      });
      return new Response(rs, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    app.get('/json', async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const server = app.listen(0);
    const port = (server as any).port;

    try {
      const r1 = await fetch(`http://localhost:${port}/stream`);
      // Streaming response should not include Access-Control-Allow-Origin/Credentials
      expect(r1.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(r1.headers.get('Access-Control-Allow-Credentials')).toBeNull();

      // Drain the streaming body to ensure the server finishes request lifecycle
      // and releases any per-request resources before issuing the next request.
      try {
        await r1.text();
      } catch (e) {
        /* ignore read errors */
      }

      const r2 = await fetch(`http://localhost:${port}/json`);
      expect(r2.headers.get('Access-Control-Allow-Origin')).toBe('*');
      // Default OM_CORS_CREDENTIALS is false, so header should be 'false'
      expect(r2.headers.get('Access-Control-Allow-Credentials')).toBe('false');
    } finally {
      server.stop(true);
    }
  });
});

import fs from 'fs';
import path from 'path';
import { test, expect } from 'bun:test';

test('startServer(options) programmatic start/stop with custom DB path', async () => {
  const tmpDir = path.resolve(process.cwd(), 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(
    tmpDir,
    `openmemory-start-${process.pid}-${Date.now()}.sqlite`,
  );

  // Prevent the module from auto-starting when imported so we can call startServer ourselves.
  process.env.OM_NO_AUTO_START = 'true';

  const port = 18000 + (process.pid % 1000);

  // Dynamically import so the OM_NO_AUTO_START env var takes effect before module init.
  const mod = await import('../../backend/src/server/index.ts');
  const start = mod.startServer as (opts?: {
    port?: number;
    dbPath?: string;
  }) => Promise<{ stop: () => Promise<void> }>;

  const server = await start({ port, dbPath });

  // Wait for health endpoint
  let ok = false;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        expect(body).toBeDefined();
        ok = true;
        break;
      }
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 200));
  }

  expect(ok).toBe(true);

  // Stop server and ensure cleanup
  await server.stop();
});

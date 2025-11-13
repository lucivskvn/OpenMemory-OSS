
import { beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";

// Prefer Bun.spawn when available (more compatible when tests run under Bun),
// fall back to child_process.spawn for Node environments.
let spawnFn: any;
try {
  // Bun exposes a global Bun.spawn
  // @ts-ignore
  if (typeof Bun !== "undefined" && (Bun as any).spawn) spawnFn = (Bun as any).spawn;
} catch (e) {
  // ignore
}
if (!spawnFn) {
  // dynamic import to avoid node/bun mismatch at load time
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  const child = await import("child_process");
  spawnFn = child.spawn;
}

let serverProcess: any;

beforeAll(async () => {
  const DEBUG = process.env.TEST_DEBUG === '1';
  if (DEBUG) console.log("[TEST SETUP] Starting backend server for integration tests...");

  // Create a temporary DB path for the server instance so tests run isolated
  const tmpDir = path.resolve(process.cwd(), "tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpDb = path.join(tmpDir, `openmemory-server-${process.pid}-${Date.now()}.sqlite`);

  // Start the server directly from source, passing OM_DB_PATH env so it uses the temp DB
  // When running under Bun we can import the server module in-process which is
  // simpler and avoids child-process lifecycle issues. Otherwise fall back to spawn.
  if (typeof Bun !== "undefined") {
    // Set OM_DB_PATH for the imported server module
    process.env.OM_DB_PATH = tmpDb;
    // Importing the module will run its top-level code which starts the server
    await import("../backend/src/server/index.ts");
    serverProcess = null; // no external process to manage
  } else {
    serverProcess = spawnFn("bun", ["run", "backend/src/server/index.ts"], {
      stdio: ["ignore", "pipe", "pipe"], // ignore stdin, pipe stdout/stderr
      detached: true, // IMPORTANT: Allows us to kill the process group
      env: { ...process.env, OM_DB_PATH: tmpDb },
    });
  }

  // Log server output for debugging (only when TEST_DEBUG=1)
  if (serverProcess && process.env.TEST_DEBUG === '1') {
    serverProcess.stdout.on('data', (data: any) => console.log(`[SERVER]: ${data}`));
    serverProcess.stderr.on('data', (data: any) => console.error(`[SERVER ERROR]: ${data}`));
  }

  // Wait for the server to be healthy before running tests
  await waitForHealthCheck();
});

afterAll(() => {
  if (process.env.TEST_DEBUG === '1') console.log("[TEST SETUP] Stopping backend server...");
  if (serverProcess && serverProcess.pid) {
    // Kill the entire process group to ensure the server and any children are terminated
    process.kill(-serverProcess.pid, 'SIGKILL');
  }
});


async function waitForHealthCheck(retries = 30, interval = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch('http://localhost:8080/health');
          if (response.ok) {
        if (process.env.TEST_DEBUG === '1') console.log('[TEST SETUP] Server is healthy and ready!');
        return;
      }
        } catch (e) {
            // Ignore fetch errors while waiting for the server to start
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Server did not become healthy after ${retries} attempts.`);
}

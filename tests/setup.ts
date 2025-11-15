
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
  // Disable noisy DB user-scope warnings by default for the test suite. Tests that
  // specifically assert the presence of these warnings (e.g. db-console.test.ts)
  // will enable OM_DB_USER_SCOPE_WARN explicitly in their own environment.
  process.env.OM_DB_USER_SCOPE_WARN = process.env.OM_DB_USER_SCOPE_WARN || "false";

  // Default test harness settings: enable test-mode hooks and prefer synthetic
  // embeddings unless a developer explicitly overrides them. This ensures the
  // test suite is deterministic and doesn't attempt external provider calls.
  process.env.OM_TEST_MODE = process.env.OM_TEST_MODE ?? '1';
  process.env.OM_EMBED_KIND = process.env.OM_EMBED_KIND ?? 'synthetic';

  // Back up and temporarily unset provider credentials/URLs so accidental
  // environment leakage doesn't cause external network calls during tests.
  // We'll restore them in `afterAll` when the test process finishes.
  const _providerBackups: Record<string, string | undefined> = {};
  const _providerVars = [
    'OPENAI_API_KEY',
    'OM_OPENAI_KEY',
    'OM_OPENAI_API_KEY',
    'OM_GEMINI_KEY',
    'GEMINI_API_KEY',
    'OM_OLLAMA_URL',
    'OM_API_KEY',
  ];
  for (const v of _providerVars) {
    _providerBackups[v] = process.env[v];
    try {
      delete process.env[v];
    } catch (e) {
      // ignore if deletion not supported in runtime
    }
  }
  // Expose backups to the global scope so afterAll can restore them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__TEST_PROVIDER_BACKUPS = _providerBackups;

  // Ensure tests use a hashed OM_API_KEY to avoid plaintext API key warnings
  // during the test run. When running under Bun we can compute an Argon2 hash
  // at runtime; otherwise fall back to a bcrypt-like placeholder to satisfy
  // `isHashedKey()` checks in tests.
  if (!process.env.OM_API_KEY) {
    try {
      if (typeof Bun !== "undefined" && (Bun as any).password && Bun.password.hash) {
        // Use a deterministic, test-only plaintext and hash it so tests can
        // exercise hashed-key flows without leaking secrets.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const hashed = await Bun.password.hash("test-integration-key");
        process.env.OM_API_KEY = hashed;
      } else {
        // A bcrypt-style placeholder that satisfies `isHashedKey()` regex.
        process.env.OM_API_KEY = "$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNO";
      }
    } catch (e) {
      // If hashing fails for any reason, set a bcrypt-like placeholder to avoid
      // triggering plaintext-key warnings during tests.
      process.env.OM_API_KEY = "$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNO";
    }
  }
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
  // Prevent accidental external network calls during tests by default.
  // Tests that need to simulate provider APIs should explicitly override
  // `globalThis.fetch` in their own scope; we back up the original here.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyG: any = globalThis as any;
    anyG.__ORIG_FETCH = anyG.fetch;
    anyG.fetch = async function () {
      throw new Error('Network access disabled by test harness');
    };
  } catch (e) {
    // ignore if runtime doesn't allow modifying fetch
  }
});

afterAll(() => {
  if (process.env.TEST_DEBUG === '1') console.log("[TEST SETUP] Stopping backend server...");
  if (serverProcess && serverProcess.pid) {
    // Kill the entire process group to ensure the server and any children are terminated
    process.kill(-serverProcess.pid, 'SIGKILL');
  }
  // Restore provider envs backed up earlier (if any). We stored backups in a
  // closure in beforeAll; expose them on globalThis so afterAll can access them.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyGlobal: any = globalThis as any;
    if (anyGlobal.__TEST_PROVIDER_BACKUPS) {
      for (const [k, v] of Object.entries(anyGlobal.__TEST_PROVIDER_BACKUPS)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v as string;
      }
    }
    // Restore any mocked global fetch
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyG: any = globalThis as any;
      if (anyG.__ORIG_FETCH) anyG.fetch = anyG.__ORIG_FETCH;
      delete anyG.__ORIG_FETCH;
    } catch (e) { }
  } catch (e) {
    // ignore
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

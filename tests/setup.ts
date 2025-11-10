import { beforeAll, afterAll } from "bun:test";
import { spawn } from "child_process";

let serverProcess: ReturnType<typeof spawn>;

beforeAll(async () => {
  console.log("[TEST SETUP] Starting backend server for integration tests...");

  // Start the server directly from source
  serverProcess = spawn("bun", ["run", "backend/src/server/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"], // ignore stdin, pipe stdout/stderr
    detached: true, // IMPORTANT: Allows us to kill the process group
  });

  // Log server output for debugging
  serverProcess.stdout.on('data', (data) => console.log(`[SERVER]: ${data}`));
  serverProcess.stderr.on('data', (data) => console.error(`[SERVER ERROR]: ${data}`));

  // Wait for the server to be healthy before running tests
  await waitForHealthCheck();
});

afterAll(() => {
  console.log("[TEST SETUP] Stopping backend server...");
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
                console.log('[TEST SETUP] Server is healthy and ready!');
                return;
            }
        } catch (e) {
            // Ignore fetch errors while waiting for the server to start
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Server did not become healthy after ${retries} attempts.`);
}

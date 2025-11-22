import { test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import http from 'http';

test('detect external podman provider and run Ollama fallback (simulated)', async () => {
    // Create a temporary PATH dir containing a fake `podman` that reports 'external compose provider'
    const tmp = await fs.promises.mkdtemp(path.join(process.cwd(), 'tmp-podman-'));
    const fakePodman = path.join(tmp, 'podman');
    const script = `#!/usr/bin/env bash
case "$1" in
  compose)
    # Simulate external provider message on "compose version"
    if [ "$2" = "version" ]; then
      echo "Executing external compose provider: podman-machine"
      exit 0
    fi
    ;;
  rm)
    exit 0
    ;;
  run)
    # pretend to start container successfully
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
    await fs.promises.writeFile(fakePodman, script, { mode: 0o755 });

    // Start a tiny HTTP server that responds to /api/health
    // Use an ephemeral port so tests won't conflict with local Ollama instances
    const server = http.createServer((req, res) => {
        if (req.url === '/api/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    // @ts-ignore - Node's Server.address() exists
    const addr: any = server.address();
    const fallbackPort = addr && addr.port ? addr.port : 11434;

    // Make sure the fake podman is first in PATH so verify_container_tooling sees it
    const env = { ...process.env, PATH: `${tmp}:${process.env.PATH}`, CONTAINER_ENGINE: 'podman', OLLAMA_PORT: String(fallbackPort) } as any;

    // Call verify_container_tooling and expect it to detect the external provider and return code 10
    const verifyCmd = spawn('bash', ['-lc', `source scripts/container-tools.sh >/dev/null 2>&1 || true; verify_container_tooling; echo RC:$?`], { env });

    let verifyOut = '';
    for await (const chunk of verifyCmd.stdout) verifyOut += chunk.toString();
    for await (const chunk of verifyCmd.stderr) verifyOut += chunk.toString();

    await new Promise((resolve) => verifyCmd.on('close', resolve));

    expect(verifyOut).toMatch(/Detected podman compose configured to use external provider|RC:10/);

    // Now call attempt_ollama_fallback - our fake podman will return success for run; our HTTP server responds to health checks
    const fallbackCmd = spawn('bash', ['-lc', `source scripts/container-tools.sh >/dev/null 2>&1 || true; attempt_ollama_fallback; echo RC:$?`], { env });

    let fallbackOut = '';
    for await (const chunk of fallbackCmd.stdout) fallbackOut += chunk.toString();
    for await (const chunk of fallbackCmd.stderr) fallbackOut += chunk.toString();

    await new Promise((resolve) => fallbackCmd.on('close', resolve));

    // fallback should attempt run and then succeed due to our local HTTP server
    expect(fallbackOut).toMatch(/Attempting lightweight Ollama fallback/);
    expect(fallbackOut).toMatch(/Fallback Ollama is up|RC:0/);

    // Cleanup
    server.close();
    try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch { }
});

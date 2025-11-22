import { test, expect } from 'bun:test';
import fs from 'fs';

test('e2e-containers.sh exposes SHOW_OLLAMA_LOGS and E2E_VERBOSE flags', async () => {
    const path = new URL('../../scripts/e2e-containers.sh', import.meta.url).pathname;
    const content = await fs.promises.readFile(path, 'utf8');

    expect(content).toContain('SHOW_OLLAMA_LOGS');
    expect(content).toContain('E2E_VERBOSE');
    // ensure default values set conservatively
    expect(content).toMatch(/SHOW_OLLAMA_LOGS=\$\{SHOW_OLLAMA_LOGS:-0\}/);
    expect(content).toMatch(/E2E_VERBOSE=\$\{E2E_VERBOSE:-0\}/);

    // new flags should exist for rebuild / cleanup behavior
    expect(content).toMatch(/FORCE_REBUILD=\$\{FORCE_REBUILD:-1\}/);
    expect(content).toMatch(/NO_CACHE=\$\{NO_CACHE:-1\}/);
    expect(content).toMatch(/PRUNE_DANGLING=\$\{PRUNE_DANGLING:-1\}/);
    expect(content).toMatch(/COMPOSE_PROJECT_NAME/);

    // script should declare and call a check that reports missing container tooling
    expect(content).toMatch(/Docker not found\.|Podman not found\.|Docker Compose plugin not available/);

    // script should detect podman using an external compose provider and warn (automation-blocking)
    expect(content).toMatch(/external compose provider|Detected podman compose is configured to use an external compose provider/);

    // script should call the system resources checker and adjust flags on low resources
    expect(content).toMatch(/check-system-resources.sh/);
    expect(content).toMatch(/Low system resources detected/);

    // The script should parse progress indicators and print human readable progress
    expect(content).toMatch(/Download progress:/);
    expect(content).toMatch(/humanize_bytes|downloaded_bytes|total_bytes/);
});

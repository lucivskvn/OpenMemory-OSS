import { test, expect } from 'bun:test';
import fs from 'fs';

test('pre-push-checks.sh will run containerized E2E early when RUN_CONTAINER_E2E=1', async () => {
    const path = new URL('../../scripts/pre-push-checks.sh', import.meta.url).pathname;
    const content = await fs.promises.readFile(path, 'utf8');

    expect(content).toContain('RUN_CONTAINER_E2E=1 set - running containerized E2E BEFORE heavy tests');
    // ensure helper alias exists in package.json
    const pkg = JSON.parse(await fs.promises.readFile(new URL('../../package.json', import.meta.url).pathname, 'utf8'));
    expect(pkg.scripts['prepush:containers']).toBeDefined();
    // ensure the script includes helpful messages for missing tools
    expect(content).toMatch(/No container CLI found\.|Docker not found\.|Podman not found\.|No fallback available and podman external provider detected|podman external provider detected/i);
    // ensure it calls the system resource checker and adapts behavior
    expect(content).toMatch(/check-system-resources.sh/);
    expect(content).toMatch(/Low system resources detected/);
    // ensure it warns about external compose providers (podman configured with docker-compose)
    expect(content).toMatch(/external compose provider|podman external provider detected|Detected podman compose is configured to use an external compose provider/i);
});

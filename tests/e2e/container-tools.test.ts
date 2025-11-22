import { test, expect } from 'bun:test';
import fs from 'fs';

test('container-tools.sh exposes helpers and fallback', async () => {
    const path = new URL('../../scripts/container-tools.sh', import.meta.url).pathname;
    const content = await fs.promises.readFile(path, 'utf8');

    expect(content).toMatch(/attempt_ollama_fallback/);
    expect(content).toMatch(/verify_container_tooling/);
    expect(content).toMatch(/suggest_install_instructions/);
    expect(content).toMatch(/detect_external_podman_provider/);
});

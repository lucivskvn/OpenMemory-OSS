import { test, expect } from 'bun:test';
import fs from 'fs';

test('automation wrapper exists and package.json scripts present', async () => {
    const path = new URL('../../scripts/automation.sh', import.meta.url).pathname;
    const content = await fs.promises.readFile(path, 'utf8');

    expect(content).toMatch(/Usage: automation.sh/);

    const pkgPath = new URL('../../package.json', import.meta.url).pathname;
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, 'utf8'));

    expect(pkg.scripts['automation']).toBeDefined();
    expect(pkg.scripts['automation:prepush']).toBeDefined();
    expect(pkg.scripts['automation:e2e:containers:smoke']).toBeDefined();
    expect(pkg.scripts['automation:verify']).toBeDefined();
});

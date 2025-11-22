import { test, expect } from 'bun:test';
import fs from 'fs';

test('system-suggestions wrapper exists and calls helper', async () => {
    const path = new URL('../../scripts/system-suggestions.sh', import.meta.url).pathname;
    const content = await fs.promises.readFile(path, 'utf8');

    expect(content).toContain('suggest_install_instructions');
});

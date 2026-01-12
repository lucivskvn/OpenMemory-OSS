import { q } from "../src/core/db";
import { env } from "../src/core/cfg";

export async function waitForDb(timeout = 10000) {
    const start = Date.now();
    // Loop until q is defined and q.insMem is defined (ensuring full initialization)
    while (!q || !q.insMem) {
        if (Date.now() - start > timeout) {
            throw new Error(`Timeout waiting for DB q object (q is ${typeof q})`);
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return true;
}

export async function forceConfigReinit() {
    // Helper to force reload config if needed
    // implementation depends on how cfg.ts handles reloading
}

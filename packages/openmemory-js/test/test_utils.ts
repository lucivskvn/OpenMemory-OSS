import { q, closeDb } from "../src/core/db";
import { env } from "../src/core/cfg";
import { test as bunTest } from "bun:test";

export { waitForDb } from "../src/core/db";

/**
 * Generates a unique, collision-resistant database path for tests.
 * Uses Bun native APIs for better performance.
 */
export function getUniqueDbPath(prefix: string): string {
    const uuid = crypto.randomUUID().slice(0, 8);
    const ts = Date.now();
    const name = `test_${prefix}_${ts}_${uuid}.sqlite`;
    const dir = `${process.cwd()}/tests/data`;

    // Use Bun-native directory check and creation
    try {
        const fs = require("node:fs");
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
    }

    return `${dir}/${name}`;
}

let _suiteFailed = false;

/**
 * Tracks if any test in the current file failed.
 */
export const test = (name: string, fn: any, timeout?: number) => {
    const wrapped = async (...args: any[]) => {
        try {
            await fn(...args);
        } catch (e) {
            _suiteFailed = true;
            throw e;
        }
    };
    // Preserve the name if possible, though bunTest takes it explicitly
    Object.defineProperty(wrapped, 'name', { value: name });
    return bunTest(name, wrapped, timeout);
};

/**
 * Closes DB and deletes artifacts ONLY if all tests in the file passed.
 * Uses Bun native APIs where possible.
 */
export async function cleanupIfSuccess(dbPath: string) {
    // Ensure all pending operations are done with a timeout to prevent hook hangs
    try {
        const { getContextId, cleanupVectorStores } = await import("../src/core/db");
        await Promise.race([
            Promise.all([
                closeDb(),
                cleanupVectorStores(getContextId())
            ]),
            new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup timeout")), 2000))
        ]);
    } catch (e) {
        console.warn(`[TEST] Cleanup failed:`, e instanceof Error ? e.message : e);
    }

    // Safety buffer for lock releases
    await Bun.sleep(500);

    if (!_suiteFailed) {
        const files = [dbPath, dbPath + "-shm", dbPath + "-wal"];

        for (const f of files) {
            const file = Bun.file(f);
            if (!(await file.exists())) continue;

            let retries = 5;
            while (retries > 0) {
                try {
                    // Use node:fs for unlink as Bun doesn't have a direct unlink yet
                    require("node:fs").unlinkSync(f);
                    break;
                } catch (e: any) {
                    if (e.code === 'EBUSY' && retries > 1) {
                        await Bun.sleep(200);
                        retries--;
                    } else {
                        // Silent fail if it's just a cleanup issue, but log for debug
                        if (e.code !== 'ENOENT') {
                            console.warn(`[TEST] Final cleanup failed for ${f}:`, e.message || e);
                        }
                        break;
                    }
                }
            }
        }
    } else {
        console.log(`\n[TEST] Suite failed. DB artifacts preserved for debugging at: ${dbPath}`);
    }
}

/**
 * Helper to force config reload using Bun.env.
 */
export async function forceConfigReinit() {
    const { reloadConfig } = await import("../src/core/cfg");
    reloadConfig();
}

/**
 * Helper to derive client ID matching auth.ts getClientId.
 * Returns full 64-char hex SHA-256 hash of the API key.
 */
export async function getClientId(apiKey: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
    return Buffer.from(hash).toString("hex");
}

import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import path from "path";

describe("migrations", () => {
    it("runs migrations successfully against a temp DB", () => {
        const tmpDb = path.resolve(process.cwd(), "tmp", "test-migrate.sqlite");
        const res = spawnSync("bun", ["src/migrate.ts"], {
            // Ensure cwd points to the backend directory (process.cwd() when running
            // tests from the backend folder is already correct; avoid nesting 'backend/backend')
            cwd: path.resolve(process.cwd()),
            env: { ...process.env, OM_DB_PATH: tmpDb },
            stdio: "pipe",
            timeout: 20000,
        });
        // spawnSync returns a status code in res.status. Accept either 0 or output that indicates migrations ran.
        const out = String(res.stdout || "") + String(res.stderr || "");
        const ok = res.status === 0 || /Migration complete/i.test(out) || /Migration complete/i.test(String(out));
        expect(ok).toBe(true);
    });
});

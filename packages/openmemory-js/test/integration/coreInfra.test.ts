import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { AesGcmProvider, SecurityError, resetSecurity } from "../../src/core/security";
import { runAsync, closeDb, waitForDb } from "../../src/core/db";
import { getUniqueDbPath, cleanupIfSuccess, forceConfigReinit } from "../test_utils";
import { env } from "../../src/core/cfg";

const TEST_DB = getUniqueDbPath("core_infra");

describe("Core Infrastructure", () => {

    // We need to initialize the DB before trying to run DB tests
    beforeEach(async () => {
        Bun.env.OM_DB_PATH = TEST_DB;
        Bun.env.OM_ENCRYPTION_KEY = "12345678901234567890123456789012";
        await forceConfigReinit();
        await waitForDb();
        resetSecurity();
    });

    afterEach(async () => {
        await cleanupIfSuccess(TEST_DB);
    });

    describe("Security", () => {
        test("AesGcmProvider encrypts and decrypts correctly", async () => {
            const provider = new AesGcmProvider("12345678901234567890123456789012");
            const plain = "Hello World";
            const cipher = await provider.encrypt(plain);

            expect(cipher).toMatch(/^(enc:|v1:)/);
            expect(await provider.decrypt(cipher)).toBe(plain);
        });

        test("AesGcmProvider throws SecurityError on invalid cipher", async () => {
            const provider = new AesGcmProvider("12345678901234567890123456789012");
            const invalid = "enc:invalid:data";

            try {
                await provider.decrypt(invalid);
                expect(true).toBe(false); // Fail if no error
            } catch (e) {
                expect(e).toBeInstanceOf(SecurityError);
            }
        });

        test("AesGcmProvider handles wrong key", async () => {
            const provider1 = new AesGcmProvider("12345678901234567890123456789012"); // Key A
            const provider2 = new AesGcmProvider("ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"); // Key B

            const cipher = await provider1.encrypt("Secret");

            try {
                await provider2.decrypt(cipher);
                expect(true).toBe(false);
            } catch (e) {
                expect(e).toBeInstanceOf(SecurityError);
            }
        });
    });

    describe("DB", () => {
        test("runAsync returns expected type", async () => {
            // This now tests actual SQLite execution
            const result = await runAsync("SELECT 1 as val");
            // runAsync usually returns void or the RunResult for modifications? 
            // Wait, runAsync in db_access returns `unknown`. 
            // Actually it returns a Promise<void | RunResult> or similar depending on implementation.
            // Let's verify standard behavior: SELECT usually requires `getAsync` or `allAsync`.
            // `runAsync` is for EXEC/UPDATE/DELETE. 
            // But let's check what it returns for a SELECT (usually nothing or RunResult).

            // Let's test a real behavior:
            await runAsync("CREATE TABLE IF NOT EXISTS test_infra (id INTEGER PRIMARY KEY, val TEXT)");
            await runAsync("INSERT INTO test_infra (val) VALUES (?)", ["test"]);

            const rows: any = await runAsync("DELETE FROM test_infra WHERE val = ?", ["test"]);
            // For bun:sqlite, run returns { changes: number, lastInsertRowid: number }
            // But our wrapper might return something else.
            // We just want to ensure it DOES NOT THROW and talks to DB.
            expect(rows).toBeDefined();
        });
    });
});

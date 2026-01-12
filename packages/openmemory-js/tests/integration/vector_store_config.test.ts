
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { env, reloadConfig } from "../../src/core/cfg";
import { SqlVectorStore } from "../../src/core/vector/sql";

// Mock DbOps
const mockDb = {
    runAsync: async () => 0,
    getAsync: async () => undefined,
    allAsync: async () => [],
    iterateAsync: async function* () { yield {} as any; }
};

describe("Vector Store Config Consistency", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        // Reset env vars
        delete process.env.OM_VECTOR_TABLE;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        reloadConfig();
    });

    test("Default Configuration uses 'vectors'", () => {
        reloadConfig();
        expect(env.vectorTable).toBe("vectors");

        // Verify SqlVectorStore defaults (if not passed name) matches env default
        // The SqlVectorStore class itself defaults to "vectors" in constructor
        const store = new SqlVectorStore(mockDb);
        // We can't easily check private property 'table' without casting
        expect((store as any).table).toBe("vectors");
    });

    test("Custom Configuration overrides correctly", () => {
        process.env.OM_VECTOR_TABLE = "custom_vectors";
        reloadConfig();
        expect(env.vectorTable).toBe("custom_vectors");

        const store = new SqlVectorStore(mockDb, env.vectorTable);
        expect((store as any).table).toBe("custom_vectors");
    });

    test("SqlVectorStore constructor default matches System default", () => {
        // This is a crucial integrity check: 
        // The code in sql.ts `tableName: string = "vectors"` MUST match what we expect.
        const store = new SqlVectorStore(mockDb);
        const defaultTable = (store as any).table;

        reloadConfig(); // Ensure clean default
        expect(env.vectorTable).toBe(defaultTable);
    });
});

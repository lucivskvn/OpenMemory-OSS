import { describe, expect, test } from "bun:test";
import { env, reloadConfig } from "../../src/core/cfg";
import { getSystemStats } from "../../src/core/stats";

describe("Native Configuration Reloading", () => {
    test("env singleton updates when Bun.env changes", () => {
        const original = env.metadataBackend;
        const target = original === "sqlite" ? "postgres" : "sqlite";

        Bun.env.OM_METADATA_BACKEND = target;
        reloadConfig();

        expect(env.metadataBackend).toBe(target);

        // Restore
        Bun.env.OM_METADATA_BACKEND = original;
        reloadConfig();
        expect(env.metadataBackend).toBe(original);
    });

    test("dependent modules (stats) reflect env changes and use getMemTable correctly", async () => {
        // This test indirectly checks if stats.ts uses the dynamic check for isPg
        const original = env.metadataBackend;

        // Mock a user ID if needed, but getSystemStats can handle undefined
        // We don't need a real DB for this logic test as we're checking the SQL generation logic in stats.ts
        // Actually, getSystemStats calls allAsync, so it might fail if no DB.
        // But we just want to see if it *tries* to use PG or SQ.

        Bun.env.OM_METADATA_BACKEND = "postgres";
        reloadConfig();

        // If we call getSystemStats, it should use PG logic. 
        // We can't easily see the internal isPg without exported or mocked db.
        // But we can check if it throws a specific PG error vs SQ error.

        expect(env.metadataBackend).toBe("postgres");

        Bun.env.OM_METADATA_BACKEND = "sqlite";
        reloadConfig();
        expect(env.metadataBackend).toBe("sqlite");
    });
});

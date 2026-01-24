import { describe, expect, test, afterEach } from "bun:test";
import { env, reloadConfig, VERSION } from "../../src/core/cfg";

describe("Configuration Audit & Mapping", () => {
    const originalEnv = { ...Bun.env };

    afterEach(() => {
        // Restore environment
        for (const key in Bun.env) {
            if (!(key in originalEnv)) delete Bun.env[key];
        }
        Object.assign(Bun.env, originalEnv);
        reloadConfig();
    });

    test("Centralized version matches package.json", async () => {
        const pkg = await import("../../package.json");
        expect(VERSION).toBe(pkg.version);
    });

    test("Automated mapping picks up OM_ prefix", () => {
        Bun.env.OM_PORT = "9999";
        Bun.env.OM_DB_PATH = "/tmp/test.sqlite";
        reloadConfig();
        expect(env.port).toBe(9999);
        expect(env.dbPath).toBe("/tmp/test.sqlite");
    });

    test("CamelCase to ScreamingSnake mapping", () => {
        Bun.env.OM_MAX_PAYLOAD_SIZE = "500000";
        reloadConfig();
        expect(env.maxPayloadSize).toBe(500000);
    });

    test("Tier-based constants update reactively", () => {
        // Test Deep Tier
        Bun.env.OM_TIER = "deep";
        reloadConfig();
        expect(env.tier).toBe("deep");
        expect(env.vecDim).toBe(1024);
        expect(env.vectorCacheSizeMb).toBe(1024);

        // Test Fast Tier
        Bun.env.OM_TIER = "fast";
        reloadConfig();
        expect(env.tier).toBe("fast");
        expect(env.vecDim).toBe(768);
        expect(env.vectorCacheSizeMb).toBe(128);
    });

    test("Boolean schema handles multiple truthy values", () => {
        Bun.env.OM_VERBOSE = "on";
        reloadConfig();
        expect(env.verbose).toBe(true);

        Bun.env.OM_VERBOSE = "yes";
        reloadConfig();
        expect(env.verbose).toBe(true);

        Bun.env.OM_VERBOSE = "1";
        reloadConfig();
        expect(env.verbose).toBe(true);
    });
});

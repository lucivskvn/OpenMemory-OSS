import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Core Configuration Module Tests
 * 
 * Tests environment variable parsing, defaults, validation, and tier selection
 * for backend/src/core/cfg.ts
 */

describe("Core Configuration (cfg.ts)", () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        // Save original environment to restore between tests
        originalEnv = { ...process.env };
        // Ensure cfg module is reloaded for each test to pick up env changes
        try {
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
        } catch { }
    });

    describe("Environment Parsing - Server Config", () => {
        test("OM_PORT defaults to 8080", async () => {
            delete process.env.OM_PORT;
            // Re-import to pick up env changes
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.port).toBe(8080);
            process.env = originalEnv;
        });

        test("OM_PORT parses valid integer", async () => {
            process.env.OM_PORT = "3000";
            // Clear module cache and re-import
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.port).toBe(3000);
            process.env = originalEnv;
        });

        test("OM_MODE defaults to development", async () => {
            delete process.env.OM_MODE;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.mode).toBe("development");
            process.env = originalEnv;
        });

        test("OM_API_KEY is optional", async () => {
            delete process.env.OM_API_KEY;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.api_key).toBeUndefined();
            process.env = originalEnv;
        });
    });

    describe("Environment Parsing - Database Config", () => {
        test("OM_METADATA_BACKEND defaults to sqlite", async () => {
            delete process.env.OM_METADATA_BACKEND;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.metadata_backend).toBe("sqlite");
            process.env = originalEnv;
        });

        test("OM_DB_PATH defaults to ./data/openmemory.sqlite", async () => {
            delete process.env.OM_DB_PATH;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.db_path).toBe("./data/openmemory.sqlite");
            process.env = originalEnv;
        });

        test("OM_METADATA_BACKEND accepts postgres", async () => {
            process.env.OM_METADATA_BACKEND = "postgres";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.metadata_backend).toBe("postgres");
            process.env = originalEnv;
        });
    });

    describe("Environment Parsing - Embedding Config", () => {
        test("OM_EMBED_KIND defaults to synthetic", async () => {
            delete process.env.OM_EMBED_KIND;
            delete process.env.OM_EMBEDDINGS;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.embed_kind).toBe("synthetic");
            process.env = originalEnv;
        });

        test("OM_EMBEDDINGS takes precedence over OM_EMBED_KIND (legacy fallback)", async () => {
            process.env.OM_EMBEDDINGS = "openai";
            process.env.OM_EMBED_KIND = "ollama";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.embed_kind).toBe("openai");
            process.env = originalEnv;
        });

        test("OM_VEC_DIM defaults to 256", async () => {
            delete process.env.OM_VEC_DIM;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.vec_dim).toBe(256);
            process.env = originalEnv;
        });

        test("OM_VEC_DIM parses custom dimension", async () => {
            process.env.OM_VEC_DIM = "1536";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.vec_dim).toBe(1536);
            process.env = originalEnv;
        });

        test("OM_EMBED_MODE defaults to advanced", async () => {
            delete process.env.OM_EMBED_MODE;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.embed_mode).toBe("advanced");
            process.env = originalEnv;
        });

        test("OM_HYBRID_FUSION defaults to true", async () => {
            delete process.env.OM_HYBRID_FUSION;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.hybrid_fusion).toBe(true);
            process.env = originalEnv;
        });

        test("OM_KEYWORD_BOOST defaults to 1.0", async () => {
            delete process.env.OM_KEYWORD_BOOST;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.keyword_boost).toBe(1.0);
            process.env = originalEnv;
        });
    });

    describe("Environment Parsing - Provider Config", () => {
        test("OPENAI_API_KEY fallback chain works", async () => {
            delete process.env.OM_OPENAI_KEY;
            delete process.env.OM_OPENAI_API_KEY;
            process.env.OPENAI_API_KEY = "sk-legacy-key";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.openai_key).toBe("sk-legacy-key");
            process.env = originalEnv;
        });

        test("OM_OPENAI_BASE_URL defaults to OpenAI API", async () => {
            delete process.env.OM_OPENAI_BASE_URL;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.openai_base_url).toBe("https://api.openai.com/v1");
            process.env = originalEnv;
        });

        test("OM_OLLAMA_URL defaults to localhost:11434", async () => {
            delete process.env.OM_OLLAMA_URL;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.ollama_url).toBe("http://localhost:11434");
            process.env = originalEnv;
        });

        test("GEMINI_API_KEY fallback chain works", async () => {
            delete process.env.OM_GEMINI_KEY;
            delete process.env.OM_GEMINI_API_KEY;
            process.env.GEMINI_API_KEY = "ai-legacy-gemini";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.gemini_key).toBe("ai-legacy-gemini");
            process.env = originalEnv;
        });
    });

    describe("Environment Parsing - Rate Limiting", () => {
        test("OM_RATE_LIMIT_ENABLED defaults to true", async () => {
            delete process.env.OM_RATE_LIMIT_ENABLED;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.rate_limit_enabled).toBe(true);
            process.env = originalEnv;
        });

        test("OM_RATE_LIMIT_WINDOW_MS defaults to 60000", async () => {
            delete process.env.OM_RATE_LIMIT_WINDOW_MS;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.rate_limit_window_ms).toBe(60000);
            process.env = originalEnv;
        });

        test("OM_RATE_LIMIT_MAX_REQUESTS defaults to 100", async () => {
            delete process.env.OM_RATE_LIMIT_MAX_REQUESTS;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.rate_limit_max_requests).toBe(100);
            process.env = originalEnv;
        });
    });

    describe("Environment Parsing - Memory Decay", () => {
        test("OM_DECAY_INTERVAL_MINUTES defaults to 1440", async () => {
            delete process.env.OM_DECAY_INTERVAL_MINUTES;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.decay_interval_minutes).toBe(1440);
            process.env = originalEnv;
        });

        test("OM_DECAY_RATIO defaults to 0.5", async () => {
            delete process.env.OM_DECAY_RATIO;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.decay_ratio).toBe(0.5);
            process.env = originalEnv;
        });

        test("OM_AUTO_REFLECT defaults to true", async () => {
            delete process.env.OM_AUTO_REFLECT;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.auto_reflect).toBe(true);
            process.env = originalEnv;
        });

        test("OM_REFLECT_MIN defaults to 20", async () => {
            delete process.env.OM_REFLECT_MIN;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.reflect_min).toBe(20);
            process.env = originalEnv;
        });
    });

    describe("Environment Parsing - Other Settings", () => {
        test("OM_MAX_PAYLOAD_SIZE defaults to 1000000", async () => {
            delete process.env.OM_MAX_PAYLOAD_SIZE;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.max_payload_size).toBe(1000000);
            process.env = originalEnv;
        });

        test("OM_LOG_AUTH defaults to false", async () => {
            delete process.env.OM_LOG_AUTH;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.log_auth).toBe(false);
            process.env = originalEnv;
        });

        test("OM_KEYWORD_MIN_LENGTH defaults to 3", async () => {
            delete process.env.OM_KEYWORD_MIN_LENGTH;
            const { env } = await import("../../backend/src/core/cfg");
            expect(env.keyword_min_length).toBe(3);
            process.env = originalEnv;
        });
    });

    describe("Tier System", () => {
        test("tier defaults to hybrid when OM_TIER not set", async () => {
            delete process.env.OM_TIER;
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { tier } = await import("../../backend/src/core/cfg");
            expect(tier).toBe("hybrid");
            process.env = originalEnv;
        });

        test("tier can be set to fast", async () => {
            process.env.OM_TIER = "fast";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { tier } = await import("../../backend/src/core/cfg");
            expect(tier).toBe("fast");
            process.env = originalEnv;
        });

        test("tier can be set to smart", async () => {
            process.env.OM_TIER = "smart";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { tier } = await import("../../backend/src/core/cfg");
            expect(tier).toBe("smart");
            process.env = originalEnv;
        });

        test("tier can be set to deep", async () => {
            process.env.OM_TIER = "deep";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { tier } = await import("../../backend/src/core/cfg");
            expect(tier).toBe("deep");
            process.env = originalEnv;
        });
    });

    describe("Protocol and Host", () => {
        test("protocol is http in development mode", async () => {
            process.env.OM_MODE = "development";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { protocol } = await import("../../backend/src/core/cfg");
            expect(protocol).toBe("http");
            process.env = originalEnv;
        });

        test("protocol is https in production mode", async () => {
            process.env.OM_MODE = "production";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { protocol } = await import("../../backend/src/core/cfg");
            expect(protocol).toBe("https");
            process.env = originalEnv;
        });

        test("host defaults to localhost", async () => {
            delete process.env.OM_HOST;
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { host } = await import("../../backend/src/core/cfg");
            expect(host).toBe("localhost");
            process.env = originalEnv;
        });
    });

    describe("Data Directory", () => {
        test("data_dir defaults to ./data", async () => {
            delete process.env.OM_DATA_DIR;
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { data_dir } = await import("../../backend/src/core/cfg");
            expect(data_dir).toBe("./data");
            process.env = originalEnv;
        });

        test("data_dir can be customized", async () => {
            process.env.OM_DATA_DIR = "/custom/data/path";
            delete require.cache[require.resolve("../../backend/src/core/cfg")];
            const { data_dir } = await import("../../backend/src/core/cfg");
            expect(data_dir).toBe("/custom/data/path");
            process.env = originalEnv;
        });
    });
});

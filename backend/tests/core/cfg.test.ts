import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

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
            delete require.cache[require.resolve("../../src/core/cfg")];
        } catch { }
    });

    afterEach(() => {
        // Restore environment after each test
        process.env = originalEnv;
    });

    describe("Environment Parsing - Server Config", () => {
        test("OM_PORT defaults to 8080", async () => {
            delete process.env.OM_PORT;
            // Re-import to pick up env changes
            const { env } = await import("../../src/core/cfg");
            expect(env.port).toBe(8080);
        });

        test("OM_PORT parses valid integer", async () => {
            process.env.OM_PORT = "3000";
            // Clear module cache and re-import
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { env } = await import("../../src/core/cfg");
            expect(env.port).toBe(3000);
        });

        test("OM_MODE defaults to development", async () => {
            delete process.env.OM_MODE;
            const { env } = await import("../../src/core/cfg");
            expect(env.mode).toBe("development");
        });

        test("OM_API_KEY is optional", async () => {
            delete process.env.OM_API_KEY;
            const { env } = await import("../../src/core/cfg");
            expect(env.api_key).toBeUndefined();
        });
    });

    describe("Environment Parsing - Database Config", () => {
        test("OM_METADATA_BACKEND defaults to sqlite", async () => {
            delete process.env.OM_METADATA_BACKEND;
            const { env } = await import("../../src/core/cfg");
            expect(env.metadata_backend).toBe("sqlite");
        });

        test("OM_DB_PATH defaults to ./data/openmemory.sqlite", async () => {
            delete process.env.OM_DB_PATH;
            const { env } = await import("../../src/core/cfg");
            expect(env.db_path).toBe("./data/openmemory.sqlite");
        });

        test("OM_METADATA_BACKEND accepts postgres", async () => {
            process.env.OM_METADATA_BACKEND = "postgres";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { env } = await import("../../src/core/cfg");
            expect(env.metadata_backend).toBe("postgres");
        });
    });

    describe("Environment Parsing - Embedding Config", () => {
        test("OM_EMBED_KIND defaults to synthetic", async () => {
            delete process.env.OM_EMBED_KIND;
            delete process.env.OM_EMBEDDINGS;
            const { env } = await import("../../src/core/cfg");
            expect(env.embed_kind).toBe("synthetic");
        });

        test("OM_EMBEDDINGS takes precedence over OM_EMBED_KIND (legacy fallback)", async () => {
            process.env.OM_EMBEDDINGS = "openai";
            process.env.OM_EMBED_KIND = "ollama";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { env } = await import("../../src/core/cfg");
            expect(env.embed_kind).toBe("openai");
        });

        test("OM_VEC_DIM defaults to 256", async () => {
            delete process.env.OM_VEC_DIM;
            const { env } = await import("../../src/core/cfg");
            expect(env.vec_dim).toBe(256);
        });

        test("OM_VEC_DIM parses custom dimension", async () => {
            process.env.OM_VEC_DIM = "1536";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { env } = await import("../../src/core/cfg");
            expect(env.vec_dim).toBe(1536);
        });

        test("OM_EMBED_MODE defaults to advanced", async () => {
            delete process.env.OM_EMBED_MODE;
            const { env } = await import("../../src/core/cfg");
            expect(env.embed_mode).toBe("advanced");
        });

        test("OM_HYBRID_FUSION defaults to true", async () => {
            delete process.env.OM_HYBRID_FUSION;
            const { env } = await import("../../src/core/cfg");
            expect(env.hybrid_fusion).toBe(true);
        });

        test("OM_KEYWORD_BOOST defaults to 1.0", async () => {
            delete process.env.OM_KEYWORD_BOOST;
            const { env } = await import("../../src/core/cfg");
            expect(env.keyword_boost).toBe(1.0);
        });
    });

    describe("Environment Parsing - Provider Config", () => {
        test("OPENAI_API_KEY fallback chain works", async () => {
            delete process.env.OM_OPENAI_KEY;
            delete process.env.OM_OPENAI_API_KEY;
            process.env.OPENAI_API_KEY = "sk-legacy-key";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { env } = await import("../../src/core/cfg");
            expect(env.openai_key).toBe("sk-legacy-key");
        });

        test("OM_OPENAI_BASE_URL defaults to OpenAI API", async () => {
            delete process.env.OM_OPENAI_BASE_URL;
            const { env } = await import("../../src/core/cfg");
            expect(env.openai_base_url).toBe("https://api.openai.com/v1");
        });

        test("OM_OLLAMA_URL defaults to localhost:11434", async () => {
            delete process.env.OM_OLLAMA_URL;
            const { env } = await import("../../src/core/cfg");
            expect(env.ollama_url).toBe("http://localhost:11434");
        });

        test("GEMINI_API_KEY fallback chain works", async () => {
            delete process.env.OM_GEMINI_KEY;
            delete process.env.OM_GEMINI_API_KEY;
            process.env.GEMINI_API_KEY = "ai-legacy-gemini";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { env } = await import("../../src/core/cfg");
            expect(env.gemini_key).toBe("ai-legacy-gemini");
        });
    });

    describe("Environment Parsing - Rate Limiting", () => {
        test("OM_RATE_LIMIT_ENABLED defaults to true", async () => {
            delete process.env.OM_RATE_LIMIT_ENABLED;
            const { env } = await import("../../src/core/cfg");
            expect(env.rate_limit_enabled).toBe(true);
        });

        test("OM_RATE_LIMIT_WINDOW_MS defaults to 60000", async () => {
            delete process.env.OM_RATE_LIMIT_WINDOW_MS;
            const { env } = await import("../../src/core/cfg");
            expect(env.rate_limit_window_ms).toBe(60000);
        });

        test("OM_RATE_LIMIT_MAX_REQUESTS defaults to 100", async () => {
            delete process.env.OM_RATE_LIMIT_MAX_REQUESTS;
            const { env } = await import("../../src/core/cfg");
            expect(env.rate_limit_max_requests).toBe(100);
        });
    });

    describe("Environment Parsing - Memory Decay", () => {
        test("OM_DECAY_INTERVAL_MINUTES defaults to 1440", async () => {
            delete process.env.OM_DECAY_INTERVAL_MINUTES;
            const { env } = await import("../../src/core/cfg");
            expect(env.decay_interval_minutes).toBe(1440);
        });

        test("OM_DECAY_RATIO defaults to 0.5", async () => {
            delete process.env.OM_DECAY_RATIO;
            const { env } = await import("../../src/core/cfg");
            expect(env.decay_ratio).toBe(0.5);
        });

        test("OM_AUTO_REFLECT defaults to true", async () => {
            delete process.env.OM_AUTO_REFLECT;
            const { env } = await import("../../src/core/cfg");
            expect(env.auto_reflect).toBe(true);
        });

        test("OM_REFLECT_MIN defaults to 20", async () => {
            delete process.env.OM_REFLECT_MIN;
            const { env } = await import("../../src/core/cfg");
            expect(env.reflect_min).toBe(20);
        });
    });

    describe("Environment Parsing - Other Settings", () => {
        test("OM_MAX_PAYLOAD_SIZE defaults to 1000000", async () => {
            delete process.env.OM_MAX_PAYLOAD_SIZE;
            const { env } = await import("../../src/core/cfg");
            expect(env.max_payload_size).toBe(1000000);
        });

        test("OM_LOG_AUTH defaults to false", async () => {
            delete process.env.OM_LOG_AUTH;
            const { env } = await import("../../src/core/cfg");
            expect(env.log_auth).toBe(false);
        });

        test("OM_KEYWORD_MIN_LENGTH defaults to 3", async () => {
            delete process.env.OM_KEYWORD_MIN_LENGTH;
            const { env } = await import("../../src/core/cfg");
            expect(env.keyword_min_length).toBe(3);
        });
    });

    describe("Tier System", () => {
        test("tier defaults to hybrid when OM_TIER not set", async () => {
            delete process.env.OM_TIER;
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { tier } = await import("../../src/core/cfg");
            expect(tier).toBe("hybrid");
        });

        test("tier can be set to fast", async () => {
            process.env.OM_TIER = "fast";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { tier } = await import("../../src/core/cfg");
            expect(tier).toBe("fast");
        });

        test("tier can be set to smart", async () => {
            process.env.OM_TIER = "smart";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { tier } = await import("../../src/core/cfg");
            expect(tier).toBe("smart");
        });

        test("tier can be set to deep", async () => {
            process.env.OM_TIER = "deep";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { tier } = await import("../../src/core/cfg");
            expect(tier).toBe("deep");
        });
    });

    describe("Protocol and Host", () => {
        test("protocol is http in development mode", async () => {
            process.env.OM_MODE = "development";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { protocol } = await import("../../src/core/cfg");
            expect(protocol).toBe("http");
        });

        test("protocol is https in production mode", async () => {
            process.env.OM_MODE = "production";
            process.env.OM_JWT_SECRET = "test-secret-for-production"; // Avoid validation exit
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { protocol } = await import("../../src/core/cfg");
            expect(protocol).toBe("https");
        });

        test("host defaults to localhost", async () => {
            delete process.env.OM_HOST;
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { host } = await import("../../src/core/cfg");
            expect(host).toBe("localhost");
        });
    });

    describe("Data Directory", () => {
        test("data_dir defaults to ./data", async () => {
            delete process.env.OM_DATA_DIR;
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { data_dir } = await import("../../src/core/cfg");
            expect(data_dir).toBe("./data");
        });

        test("data_dir can be customized", async () => {
            process.env.OM_DATA_DIR = "/custom/data/path";
            delete require.cache[require.resolve("../../src/core/cfg")];
            const { data_dir } = await import("../../src/core/cfg");
            expect(data_dir).toBe("/custom/data/path");
        });
    });

    describe("Runtime Validation for Universal Auth/Bucket", () => {
        let originalWarn: typeof console.warn;
        let originalError: typeof console.error;
        let originalExit: typeof process.exit;

        let warnCalls: any[] = [];
        let errorCalls: any[] = [];
        let exitCalls: any[] = [];

        beforeEach(() => {
            // Set environment to avoid default warnings - use complete configs
            process.env.OM_AUTH_PROVIDER = "supabase"; // Avoid JWT warnings
            delete process.env.OM_JWT_SECRET;
            process.env.OM_BUCKET_PROVIDER = "s3"; // S3 provider
            process.env.OM_BUCKET_ACCESS_KEY = "test-access"; // Provide creds
            process.env.OM_BUCKET_SECRET_KEY = "test-secret";
            process.env.OM_BUCKET_ENDPOINT = "https://s3.amazonaws.com";
            process.env.OM_BUCKET_REGION = "us-east-1";
            process.env.OM_TEST_MODE = '1'; // Prevent test exits

            // Save original functions
            originalWarn = console.warn;
            originalError = console.error;
            originalExit = process.exit;

            // Reset call arrays
            warnCalls = [];
            errorCalls = [];
            exitCalls = [];

            console.warn = (...args) => {
                warnCalls.push(args);
                originalWarn(...args); // Still show output
            };
            console.error = (...args) => {
                errorCalls.push(args);
                originalError(...args);
            };
            process.exit = ((code?: number) => {
                exitCalls.push(code || 0);
                if (code !== 0) {
                    throw new Error('exit');
                }
            }) as typeof process.exit;
        });

        afterEach(() => {
            // Restore original functions
            console.warn = originalWarn;
            console.error = originalError;
            process.exit = originalExit;
        });

        describe("JWT Authentication Validation", () => {
            test("dev mode: JWT provider without secret warns and allows fallback", () => {
                process.env.OM_MODE = "development";
                process.env.OM_AUTH_PROVIDER = "jwt";
                delete process.env.OM_JWT_SECRET;
                delete process.env.OM_BUCKET_PROVIDER; // Prevent bucket warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");
                // Trigger router parsing via getConfig which performs JSON.parse inside its body
                const { getConfig } = require("../../src/core/cfg");
                getConfig();

                expect(warnCalls.length).toBe(1);
                expect(warnCalls[0][0]).toContain("OM_AUTH_PROVIDER=jwt is configured but OM_JWT_SECRET is missing");
                expect(exitCalls.length).toBe(0);
                expect(cfg.jwt_enabled).toBe(false);
            });

            test("prod mode: JWT provider without secret logs error and exits", () => {
                process.env.OM_MODE = "production";
                process.env.OM_AUTH_PROVIDER = "jwt";
                delete process.env.OM_JWT_SECRET;
                delete process.env.OM_TEST_MODE; // Allow exit for this test

                expect(() => {
                    delete require.cache[require.resolve("../../src/core/cfg")];
                    require("../../src/core/cfg");
                }).toThrow('exit');

                expect(errorCalls.length).toBe(1);
                expect(errorCalls[0][0]).toContain("OM_AUTH_PROVIDER=jwt requires OM_JWT_SECRET; exiting for safety in production mode");
                expect(exitCalls.length).toBe(1);
                expect(exitCalls[0]).toBe(1);
            });

            test("dev mode: JWT provider with secret succeeds silently", () => {
                process.env.OM_MODE = "development";
                process.env.OM_AUTH_PROVIDER = "jwt";
                process.env.OM_JWT_SECRET = "test-secret-key";
                delete process.env.OM_BUCKET_PROVIDER; // Prevent bucket warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(warnCalls.length).toBe(0);
                expect(exitCalls.length).toBe(0);
                expect(cfg.jwt_enabled).toBe(true);
            });
        });

        describe("Bucket Configuration Validation", () => {
            test("S3 provider missing access key warns", () => {
                process.env.OM_MODE = "production";
                process.env.OM_BUCKET_PROVIDER = "s3";
                delete process.env.OM_BUCKET_ACCESS_KEY;
                delete process.env.OM_BUCKET_SECRET_KEY;
                process.env.OM_BUCKET_ENDPOINT = "https://s3.amazonaws.com";
                process.env.OM_BUCKET_REGION = "us-east-1";
                // OM_AUTH_PROVIDER already set to supabase in beforeEach to prevent JWT warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(warnCalls.length).toBe(1);
                expect(warnCalls[0][0]).toContain("OM_BUCKET_PROVIDER=s3 requires OM_BUCKET_ACCESS_KEY and OM_BUCKET_SECRET_KEY");
                expect(exitCalls.length).toBe(0);
                expect(cfg.bucket_s3_configured).toBe(false);
            });

            test("S3 provider missing secret key warns", () => {
                process.env.OM_MODE = "production";
                process.env.OM_BUCKET_PROVIDER = "s3";
                process.env.OM_BUCKET_ACCESS_KEY = "test-access";
                delete process.env.OM_BUCKET_SECRET_KEY;
                // OM_AUTH_PROVIDER already set to supabase in beforeEach to prevent JWT warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(warnCalls.length).toBe(1);
                expect(warnCalls[0][0]).toContain("OM_BUCKET_PROVIDER=s3 requires OM_BUCKET_ACCESS_KEY and OM_BUCKET_SECRET_KEY");
                expect(cfg.bucket_s3_configured).toBe(false);
            });

            test("S3 provider with valid creds sets bucket_s3_configured flag", () => {
                process.env.OM_BUCKET_PROVIDER = "s3";
                process.env.OM_BUCKET_ACCESS_KEY = "test-access";
                process.env.OM_BUCKET_SECRET_KEY = "test-secret";
                // OM_AUTH_PROVIDER already set to supabase in beforeEach to prevent JWT warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(warnCalls.length).toBe(0);
                expect(cfg.bucket_s3_configured).toBe(true);
            });

            test("non-S3 provider missing endpoint warns", () => {
                process.env.OM_BUCKET_PROVIDER = "minio";
                delete process.env.OM_BUCKET_ENDPOINT;
                delete process.env.OM_BUCKET_ACCESS_KEY;
                delete process.env.OM_BUCKET_SECRET_KEY;
                process.env.OM_AUTH_PROVIDER = "supabase"; // Prevent JWT warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(warnCalls.length).toBe(1);
                expect(warnCalls[0][0]).toContain("OM_BUCKET_PROVIDER=minio requires OM_BUCKET_ENDPOINT, OM_BUCKET_ACCESS_KEY and OM_BUCKET_SECRET_KEY");
                expect(cfg.bucket_s3_configured).toBe(false);
            });

            test("Supabase provider missing secret key warns", () => {
                process.env.OM_BUCKET_PROVIDER = "supabase";
                process.env.OM_BUCKET_ENDPOINT = "https://test.supabase.co";
                process.env.OM_BUCKET_ACCESS_KEY = "test-access";
                delete process.env.OM_BUCKET_SECRET_KEY;
                process.env.OM_AUTH_PROVIDER = "supabase"; // Prevent JWT warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(warnCalls.length).toBe(1);
                expect(warnCalls[0][0]).toContain("OM_BUCKET_PROVIDER=supabase requires OM_BUCKET_ENDPOINT, OM_BUCKET_ACCESS_KEY and OM_BUCKET_SECRET_KEY");
                expect(cfg.bucket_s3_configured).toBe(false);
            });
        });

        describe("Configuration Flags State Validation", () => {
            test("jwt_enabled flag false when secret missing", () => {
                process.env.OM_AUTH_PROVIDER = "jwt";
                delete process.env.OM_JWT_SECRET;

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(cfg.jwt_enabled).toBe(false);
            });

            test("jwt_enabled flag true when secret present", () => {
                process.env.OM_AUTH_PROVIDER = "jwt";
                process.env.OM_JWT_SECRET = "valid-secret";

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(cfg.jwt_enabled).toBe(true);
            });

            test("bucket_s3_configured false when provider is S3 but creds missing", () => {
                process.env.OM_BUCKET_PROVIDER = "s3";
                delete process.env.OM_BUCKET_ACCESS_KEY;
                delete process.env.OM_BUCKET_SECRET_KEY;

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(cfg.bucket_s3_configured).toBe(false);
            });

            test("bucket_s3_configured true only for valid S3", () => {
                process.env.OM_BUCKET_PROVIDER = "s3";
                process.env.OM_BUCKET_ACCESS_KEY = "access";
                process.env.OM_BUCKET_SECRET_KEY = "secret";

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg1 = require("../../src/core/cfg");

                expect(cfg1.bucket_s3_configured).toBe(true);

                // Clear cache and test that non-S3 provider returns false
                delete require.cache[require.resolve("../../src/core/cfg")];
                process.env.OM_BUCKET_PROVIDER = "minio";
                process.env.OM_BUCKET_ACCESS_KEY = "access";
                process.env.OM_BUCKET_SECRET_KEY = "secret";

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg2 = require("../../src/core/cfg");

                expect(cfg2.bucket_s3_configured).toBe(false);
            });
        });

        describe("Zod Schema Validation and Edge Cases", () => {
            test("invalid OM_ROUTER_SECTOR_MODELS JSON warns and defaults to null", () => {
                process.env.OM_ROUTER_SECTOR_MODELS = "invalid-json{";
                process.env.OM_AUTH_PROVIDER = "supabase"; // Prevent JWT warnings
                process.env.OM_BUCKET_PROVIDER = "s3"; // Prevent bucket warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                // The JSON should fail to parse, so the router sector models should default to null
                const { getConfig } = require("../../src/core/cfg");
                expect(getConfig().router_sector_models).toBeNull();
                // Should not crash, just warn and default

            });

            test("valid OM_ROUTER_SECTOR_MODELS JSON parses correctly", () => {
                process.env.OM_ROUTER_SECTOR_MODELS = '{"semantic": "nomic-embed-text"}';
                process.env.OM_AUTH_PROVIDER = "supabase"; // Prevent JWT warnings
                process.env.OM_BUCKET_PROVIDER = "s3"; // Prevent bucket warnings

                delete require.cache[require.resolve("../../src/core/cfg")];
                const cfg = require("../../src/core/cfg");

                expect(warnCalls.length).toBe(0);
                expect(cfg.env.router_sector_models).toEqual({
                    semantic: "nomic-embed-text"
                });
            });

            test("zod schema validation fails and exits early", () => {
                process.env.OM_MODE = "invalid-mode";
                process.env.OM_AUTH_PROVIDER = "supabase"; // Prevent JWT warnings
                process.env.OM_BUCKET_PROVIDER = "s3"; // Prevent bucket warnings

                expect(() => {
                    delete require.cache[require.resolve("../../src/core/cfg")];
                    require("../../src/core/cfg");
                }).toThrow();

                expect(errorCalls.length).toBe(1);
                expect(errorCalls[0][0]).toContain("Invalid environment variables");
                expect(exitCalls.length).toBe(1);
                expect(exitCalls[0]).toBe(1);
            });
        });
    });

    describe("getConfig() with Auth and Bucket Fields", () => {
        test("exposes new auth fields", async () => {
            process.env.OM_AUTH_PROVIDER = "jwt";
            process.env.OM_JWT_SECRET = "test-secret";
            process.env.OM_JWT_ISSUER = "https://test.com";
            process.env.OM_JWT_AUDIENCE = "test-aud";

            process.env.OM_BUCKET_PROVIDER = "minio";
            process.env.OM_BUCKET_ENDPOINT = "http://minio:9000";
            process.env.OM_BUCKET_ACCESS_KEY = "minioadmin";
            process.env.OM_BUCKET_SECRET_KEY = "minioadmin";

            delete require.cache[require.resolve("../../src/core/cfg")];
            const { getConfig } = await import("../../src/core/cfg");
            const config = getConfig();

            expect(config.auth_provider).toBe("jwt");
            expect(config.jwt_secret).toBe("test-secret");
            expect(config.jwt_issuer).toBe("https://test.com");
            expect(config.jwt_audience).toBe("test-aud");

            expect(config.bucket_provider).toBe("minio");
            expect(config.bucket_endpoint).toBe("http://minio:9000");
            expect(config.bucket_access_key).toBe("minioadmin");
            expect(config.bucket_secret_key).toBe("minioadmin");
        });

        test("exposes PostgreSQL connection string", async () => {
            const pgConnStr = "postgresql://user:pass@localhost:5432/testdb?sslmode=require";
            process.env.OM_PG_CONNECTION_STRING = pgConnStr;

            delete require.cache[require.resolve("../../src/core/cfg")];
            const { getConfig } = await import("../../src/core/cfg");
            const config = getConfig();

            expect(config.pg_connection_string).toBe(pgConnStr);
        });

        test("integration: getConfig with combined auth, bucket, and postgres vars", async () => {
            // Combine auth and bucket config with postgres vars for integration test
            process.env.OM_AUTH_PROVIDER = "jwt";
            process.env.OM_JWT_SECRET = "test-secret";
            process.env.OM_BUCKET_PROVIDER = "minio";
            process.env.OM_BUCKET_ENDPOINT = "http://minio:9000";
            process.env.OM_BUCKET_ACCESS_KEY = "minioadmin";
            process.env.OM_BUCKET_SECRET_KEY = "minioadmin";
            const pgConnStr = "postgresql://user:pass@localhost:5432/testdb?sslmode=require";
            process.env.OM_PG_CONNECTION_STRING = pgConnStr;

            delete require.cache[require.resolve("../../src/core/cfg")];
            const { getConfig } = await import("../../src/core/cfg");
            const config = getConfig();

            // No extra errors should occur when combining these vars
            expect(config.auth_provider).toBe("jwt");
            expect(config.jwt_secret).toBe("test-secret");
            expect(config.bucket_provider).toBe("minio");
            expect(config.bucket_endpoint).toBe("http://minio:9000");
            expect(config.bucket_access_key).toBe("minioadmin");
            expect(config.bucket_secret_key).toBe("minioadmin");
            expect(config.pg_connection_string).toBe(pgConnStr);
        });
    });
});

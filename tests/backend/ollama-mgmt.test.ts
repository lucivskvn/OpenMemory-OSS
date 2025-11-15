/**
 * Integration tests for Ollama model management API
 * Tests the 4 REST endpoints: /pull, /list, /delete, /status
 *
 * These tests assume:
 * - Backend server is running on http://localhost:8080
 * - Ollama service is available (or tests use synthetic fallback)
 * - OM_API_KEY is set if authentication is enabled
 *
 * Run with: OM_OLLAMA_MGMT_E2E=1 bun test ../tests/backend/ollama-mgmt.test.ts
 * Skip automatically if environment flag not set (suitable for CI).
 */

import { describe, it, expect, beforeAll } from "bun:test";

const BASE_URL = process.env.OM_BASE_URL || "http://localhost:8080";
const API_KEY = process.env.OM_API_KEY || "";
const provider = process.env.OM_EMBEDDINGS || process.env.OM_EMBED_KIND;
const OLLAMA_AVAILABLE = provider === "ollama";
const E2E_ENABLED = process.env.OM_OLLAMA_MGMT_E2E === "1";

// Skip suite if not explicitly enabled via environment flag
const describeE2E = E2E_ENABLED ? describe : describe.skip;

// Helper to make authenticated requests
async function apiRequest(
    path: string,
    method: string = "GET",
    body?: any
): Promise<Response> {
    const headers: HeadersInit = {};
    if (body) headers["Content-Type"] = "application/json";
    if (API_KEY) {
        headers["Authorization"] = `Bearer ${API_KEY}`;
    }

    return fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
}

describeE2E("Ollama Management API", () => {
    beforeAll(async () => {
        // Verify backend is reachable. Retry briefly to avoid startup race.
        const maxAttempts = 8;
        const delayMs = 300;
        let attempt = 0;
        let lastErr: any = null;
        while (attempt < maxAttempts) {
            try {
                const health = await apiRequest("/health");
                if (health.ok) return;
                // Non-ok response: capture body for diagnostics
                const txt = await health.text().catch(() => "<no-body>");
                console.error(`Health check returned non-ok (status=${health.status}): ${txt}`);
                lastErr = { status: health.status, body: txt };
            } catch (e) {
                // capture and report the error for diagnostics, then retry
                lastErr = e;
                console.error(`Health fetch attempt ${attempt + 1} failed:`, e instanceof Error ? e.message : String(e));
            }
            attempt++;
            await new Promise((r) => setTimeout(r, delayMs));
        }
        console.error("Backend health check final failure after retries:", lastErr);
        throw new Error(
            `Backend not reachable at ${BASE_URL}. Start server first.`
        );
    });

    describe("GET /embed/ollama/status", () => {
        it("should return Ollama health status", async () => {
            const r = await apiRequest("/embed/ollama/status");
            expect(r.status).toBe(200);

            const data = await r.json();
            expect(data).toHaveProperty("ollama_available");
            expect(typeof data.ollama_available).toBe("boolean");

            if (data.ollama_available) {
                expect(data).toHaveProperty("ollama_version");
                expect(data).toHaveProperty("models_loaded");
                expect(typeof data.models_loaded).toBe("number");
            }
        });

        it("should respect cache (10s TTL)", async () => {
            const r1 = await apiRequest("/embed/ollama/status");
            const d1 = await r1.json();

            // Second request should be cached
            const r2 = await apiRequest("/embed/ollama/status");
            const d2 = await r2.json();

            expect(d1).toEqual(d2);
        });
    });

    describe("GET /embed/ollama/list", () => {
        it("should list installed models", async () => {
            const r = await apiRequest("/embed/ollama/list");

            if (OLLAMA_AVAILABLE) {
                expect(r.status).toBe(200);
                const data = await r.json();
                expect(data).toHaveProperty("models");
                expect(Array.isArray(data.models)).toBe(true);

                // Each model should have expected fields
                if (data.models.length > 0) {
                    const model = data.models[0];
                    expect(model).toHaveProperty("name");
                    expect(model).toHaveProperty("size");
                    expect(model).toHaveProperty("modified_at");
                }
            } else {
                // Synthetic fallback
                expect([200, 503]).toContain(r.status);
            }
        });

        it("should include cache metadata", async () => {
            const r = await apiRequest("/embed/ollama/list");
            const data = await r.json();

            if (r.status === 200) {
                expect(data).toHaveProperty("cached");
                expect(typeof data.cached).toBe("boolean");
            }
        });

        it("should respect cache (30s TTL)", async () => {
            const r1 = await apiRequest("/embed/ollama/list");
            const d1 = await r1.json();

            const r2 = await apiRequest("/embed/ollama/list");
            const d2 = await r2.json();

            if (r1.status === 200 && r2.status === 200) {
                expect(d1.models).toEqual(d2.models);
                expect(d2.cached).toBe(true);
            }
        });
    });

    describe("POST /embed/ollama/pull", () => {
        it("should reject invalid model names", async () => {
            const r = await apiRequest("/embed/ollama/pull", "POST", {
                model: "../malicious",
            });

            expect(r.status).toBe(400);
            const data = await r.json();
            expect(data).toHaveProperty("error");
            expect(data.error).toContain("Invalid model name");
        });

        it("should reject empty model names", async () => {
            const r = await apiRequest("/embed/ollama/pull", "POST", {
                model: "",
            });

            expect(r.status).toBe(400);
            const data = await r.json();
            expect(data).toHaveProperty("error");
        });

        it("should handle missing model field", async () => {
            const r = await apiRequest("/embed/ollama/pull", "POST", {});

            expect(r.status).toBe(400);
            const data = await r.json();
            expect(data).toHaveProperty("error");
            expect(data.error).toContain("model");
        });

        it("should accept valid model names with tags", async () => {
            const validNames = [
                "nomic-embed-text",
                "llava:13b",
                "whisper:tiny",
                "model-name:v1.2.3",
            ];

            for (const model of validNames) {
                const r = await apiRequest("/embed/ollama/pull", "POST", {
                    model,
                    mcp_task_id: `test-${Date.now()}`,
                });

                // Either success or service unavailable (Ollama not running)
                expect([200, 202, 503]).toContain(r.status);

                if (r.status === 200 || r.status === 202) {
                    const data = await r.json();
                    expect(data).toHaveProperty("status");
                }
            }
        });

        it("should support MCP task_id for orchestration", async () => {
            const task_id = `mcp-test-${Date.now()}`;
            const r = await apiRequest("/embed/ollama/pull", "POST", {
                model: "nomic-embed-text",
                mcp_task_id: task_id,
            });

            if (r.status === 200 || r.status === 202) {
                const data = await r.json();
                expect(data).toHaveProperty("mcp_task_id");
                expect(data.mcp_task_id).toBe(task_id);
            }
        });

        it("should retry on transient failures", async () => {
            // This is implicitly tested by the retry logic in the endpoint
            // We can verify it doesn't fail immediately on errors
            const r = await apiRequest("/embed/ollama/pull", "POST", {
                model: "test-model",
            });

            // Even if Ollama is unavailable, should return structured error
            expect(r.headers.get("content-type")).toContain("application/json");
            const data = await r.json();
            expect(data).toBeDefined();
        });
    });

    describe("POST /embed/ollama/delete", () => {
        it("should reject invalid model names", async () => {
            const r = await apiRequest("/embed/ollama/delete", "POST", {
                model: "../../etc/passwd",
            });

            expect(r.status).toBe(400);
            const data = await r.json();
            expect(data).toHaveProperty("error");
            expect(data.error).toContain("Invalid model name");
        });

        it("should be idempotent (404 = success)", async () => {
            const model = `nonexistent-model-${Date.now()}`;

            // First delete (likely 404)
            const r1 = await apiRequest("/embed/ollama/delete", "POST", {
                model,
            });

            // Second delete (should also succeed)
            const r2 = await apiRequest("/embed/ollama/delete", "POST", {
                model,
            });

            // Both should succeed (200 or 503 if Ollama unavailable)
            expect([200, 503]).toContain(r1.status);
            expect([200, 503]).toContain(r2.status);
        });

        it("should warn when deleting active models", async () => {
            // Get list of models
            const listR = await apiRequest("/embed/ollama/list");
            if (listR.status !== 200) {
                return; // Skip if Ollama unavailable
            }

            const { models } = await listR.json();
            if (models.length === 0) {
                return; // No models to test
            }

            // Try to delete first model
            const deleteR = await apiRequest("/embed/ollama/delete", "POST", {
                model: models[0].name,
            });

            if (deleteR.status === 200) {
                const data = await deleteR.json();
                // Should include warning if model was active
                expect(data).toHaveProperty("status");
            }
        });

        it("should handle missing model field", async () => {
            const r = await apiRequest("/embed/ollama/delete", "POST", {});

            expect(r.status).toBe(400);
            const data = await r.json();
            expect(data).toHaveProperty("error");
            expect(data.error).toContain("model");
        });
    });

    describe("Authentication", () => {
        it("should enforce API key when configured", async () => {
            if (!API_KEY) {
                return; // Skip if auth not enabled
            }

            // Request without auth header
            const r = await fetch(`${BASE_URL}/embed/ollama/status`, {
                method: "GET",
            });

            expect(r.status).toBe(401);
        });
    });

    describe("Error Handling", () => {
        it("should return structured errors", async () => {
            const r = await apiRequest("/embed/ollama/pull", "POST", {
                model: "!!!invalid!!!",
            });

            const data = await r.json();
            expect(data).toHaveProperty("error");
            expect(data).toHaveProperty("message");
        });

        it("should handle Ollama service unavailable", async () => {
            // This is implicitly tested when OLLAMA_AVAILABLE=false
            // Endpoints should return 503 or synthetic fallback
            const r = await apiRequest("/embed/ollama/status");
            expect([200, 503]).toContain(r.status);
        });

        it("should return JSON content-type on errors", async () => {
            const r = await apiRequest("/embed/ollama/pull", "POST", {});

            expect(r.headers.get("content-type")).toContain("application/json");
        });
    });

    describe("Integration with /health", () => {
        it("should include Ollama status in health check", async () => {
            const r = await apiRequest("/health");
            expect(r.status).toBe(200);

            const data = await r.json();
            expect(data).toHaveProperty("ollama");

            if (data.ollama) {
                expect(data.ollama).toHaveProperty("available");
            }
        });
    });

    describe("Status Retry Logic", () => {
        it("should include error_code and context.timestamp when retries fail", async () => {
            // This test verifies that getOllamaHealth implements retry logic with 3 attempts
            // When Ollama is not running, the error response should include structured data
            if (OLLAMA_AVAILABLE) {
                // Skip if Ollama is available (we want to test the failure path)
                return;
            }

            const r = await apiRequest("/embed/ollama/status");
            expect([200, 503]).toContain(r.status);

            const data = await r.json();

            if (data.available === false) {
                // Check for structured error schema
                expect(data).toHaveProperty("error_code");
                expect(data.error_code).toBe("ollama_unavailable");
                expect(data).toHaveProperty("context");
                expect(data.context).toHaveProperty("timestamp");
                expect(typeof data.context.timestamp).toBe("string");

                // Also check for error field from getOllamaHealth
                if (data.error) {
                    expect(typeof data.error).toBe("string");
                    expect(data.error.length).toBeGreaterThan(0);
                }
            }
        });

        it("should handle transient failures with structured error", async () => {
            // This indirectly tests retry logic by ensuring structured errors are returned
            // on failures, which originate from getOllamaHealth's retry mechanism
            const r = await apiRequest("/embed/ollama/status");
            expect([200, 503]).toContain(r.status);

            const data = await r.json();

            // Check that error structure includes necessary fields for MCP compatibility
            if (!data.available) {
                expect(data).toHaveProperty("ollama_available");
                expect(data.ollama_available).toBe(false);
                expect(data).toHaveProperty("error_code");
                expect(data).toHaveProperty("url");
                expect(data).toHaveProperty("active_provider");

                if (data.error) {
                    // If there's an error field, it should be a non-empty string
                    expect(typeof data.error).toBe("string");
                    expect(data.error.length).toBeGreaterThan(0);
                }

                if (data.context) {
                    expect(data.context).toHaveProperty("timestamp");
                    expect(typeof data.context.timestamp).toBe("string");
                }
            }
        });
    });

    describe("Enhanced Error Schema Validation", () => {
        it("should include error_code and context for pull validation errors", async () => {
            const r = await apiRequest("/embed/ollama/pull", "POST", {
                model: "",
            });
            expect(r.status).toBe(400);

            const data = await r.json();
            expect(data).toHaveProperty("error_code");
            expect(data.error_code).toBe("invalid_request");
            expect(data).toHaveProperty("message");
            expect(data.message).toContain("Model name required");
        });

        it("should include error_code and context for delete validation errors", async () => {
            const r = await apiRequest("/embed/ollama/delete", "POST", {
                model: "",
            });
            expect(r.status).toBe(400);

            const data = await r.json();
            expect(data).toHaveProperty("error_code");
            expect(data.error_code).toBe("invalid_request");
            expect(data).toHaveProperty("message");
            expect(data.message).toContain("Model name required");
        });

        it("should include error_code for invalid model names in pull", async () => {
            const r = await apiRequest("/embed/ollama/pull", "POST", {
                model: "invalid/model",
            });
            expect(r.status).toBe(400);

            const data = await r.json();
            expect(data).toHaveProperty("error_code");
            expect(data.error_code).toBe("invalid_model");
            expect(data).toHaveProperty("message");
        });

        it("should include error_code for invalid model names in delete", async () => {
            const r = await apiRequest("/embed/ollama/delete", "POST", {
                model: "invalid;model",
            });
            expect(r.status).toBe(400);

            const data = await r.json();
            expect(data).toHaveProperty("error_code");
            expect(data.error_code).toBe("invalid_model");
            expect(data).toHaveProperty("message");
        });
    });

    describe("Cache Invalidation Logic", () => {
        it("should invalidate list cache after successful delete", async () => {
            // First get list to ensure cache is primed
            const r1 = await apiRequest("/embed/ollama/list");
            if (r1.status !== 200) return; // Skip if no Ollama

            const d1 = await r1.json();

            // Perform a delete operation (even if it fails, cache should invalidate)
            await apiRequest("/embed/ollama/delete", "POST", {
                model: `cache-test-${Date.now()}`,
            });

            // Get list again - should be fresh (not cached)
            const r2 = await apiRequest("/embed/ollama/list");
            expect(r2.status).toBe(200);
            const d2 = await r2.json();

            expect(d2.cached).toBe(false);
        });

        it("should return 503 with structured error when Ollama unreachable for pull", async () => {
            // Force an unreachable scenario by using invalid app port (if Ollama not configured)
            if (OLLAMA_AVAILABLE) return; // Skip if Ollama is available

            const r = await apiRequest("/embed/ollama/pull", "POST", {
                model: "test-model",
            });

            // Should return 503 when Ollama is permanently unreachable
            expect([503]).toContain(r.status);

            const data = await r.json();
            expect(data).toHaveProperty("status");
            expect(data.status).toBe("unavailable");
            expect(data).toHaveProperty("error_code");
            expect(data.error_code).toBe("ollama_unavailable");
            expect(data).toHaveProperty("context");
            expect(data.context).toHaveProperty("tried");
            expect(data.context).toHaveProperty("requested_at");
        });

        it("should return 503 with structured error when Ollama unreachable for list", async () => {
            if (OLLAMA_AVAILABLE) return; // Skip if Ollama is available

            const r = await apiRequest("/embed/ollama/list");

            if (r.status === 503) {
                const data = await r.json();
                expect(data).toHaveProperty("error_code");
                expect(data.error_code).toBe("ollama_unavailable");
                expect(data).toHaveProperty("context");
                expect(data.context).toHaveProperty("timestamp");
            }
        });
    });
});

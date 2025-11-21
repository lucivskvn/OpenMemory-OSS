import { test, expect } from "bun:test";

// This unit test programmatically starts the backend with Ollama configured
// as the embedding provider. We intentionally point it at an unreachable URL
// to validate the `GET /embed/ollama/status` route always returns a consistent
// health-shaped object with `ollama_available`, `ollama_version`, and
// `models_loaded` keys.

test("embed/ollama/status returns consistent shape when Ollama unreachable", async () => {
    // Use a free port to avoid collisions during parallel test runs
    const port = 19000 + (process.pid % 1000);

    // Prevent automatic startup of the application when importing module
    process.env.OM_NO_AUTO_START = "true";

    // Ensure tests talk to a backend configured to use Ollama but point at a
    // likely-unavailable host so we can assert the fallback shape.
    process.env.OM_EMBEDDINGS = "ollama";
    process.env.OM_OLLAMA_URL = "http://127.0.0.1:11999"; // unlikely to be up in CI
    // Run tests using SQLite metadata backend (avoid Postgres client detection in some CI hosts)
    process.env.OM_METADATA_BACKEND = "sqlite";

    // Allow tests to inject deterministic Ollama health to avoid long
    // retry delays in CI when Ollama is unreachable.
    const embed = await import("../../backend/src/memory/embed.ts");
    // Provide a deterministic health object so /embed/ollama/status returns
    // quickly and with the expected shape regardless of network availability.
    if (embed && embed.__TEST_ollama) {
        (embed.__TEST_ollama as any).health = () => ({ available: false, version: "unknown", models_loaded: 0 });
    }

    // Import and start server programmatically
    const mod = await import("../../backend/src/server/index.ts");
    const start = mod.startServer as (opts?: { port?: number; dbPath?: string; waitUntilReady?: boolean }) => Promise<{ stop: () => Promise<void>; port: number }>;
    const server = await start({ port, waitUntilReady: true });

    // Wait for server health
    let ok = false;
    for (let i = 0; i < 20; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) {
                ok = true;
                break;
            }
        } catch (_) {
            /* retry */
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    expect(ok).toBe(true);

    // Now call the endpoint under test
    const r = await fetch(`http://127.0.0.1:${server.port}/embed/ollama/status`);
    // The endpoint may return 200 or 503 depending on whether Ollama is
    // reachable in the test environment. The primary assertion is that the
    // returned shape remains consistent and contains the expected fields.
    expect([200, 503]).toContain(r.status);
    const json = await r.json();

    // The shape must be stable and include these fields per design
    expect(json).toHaveProperty("ollama_available");
    expect(typeof json.ollama_available).toBe("boolean");
    expect(json).toHaveProperty("ollama_version");
    expect(json).toHaveProperty("models_loaded");
    expect(typeof json.models_loaded).toBe("number");

    // Cleanup
    await server.stop();
});

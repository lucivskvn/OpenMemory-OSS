import { test, expect } from "bun:test";

// This integration test exercises the Bun Postgres path. It only runs when
// OM_METADATA_BACKEND=postgres. When running locally without Postgres, it
// will be skipped.

test("postgres integration: start server and crud memory", async () => {
    if (process.env.OM_METADATA_BACKEND !== "postgres") {
        console.log("Skipping Postgres integration test (OM_METADATA_BACKEND != postgres)");
        return;
    }

    // Ensure required PG env vars exist
    const host = process.env.OM_PG_HOST || "127.0.0.1";
    const port = process.env.OM_PG_PORT || "5432";
    const db = process.env.OM_PG_DB || "openmemory";
    const user = process.env.OM_PG_USER || "om";

    console.log(`Running Postgres integration test against ${user}@${host}:${port}/${db}`);

    // Prevent auto-start so we can control lifecycle
    process.env.OM_NO_AUTO_START = "true";

    // Import the server module and programmatically start it
    const mod = await import("../../backend/src/server/index.ts");
    const start = mod.startServer as (opts?: { port?: number; dbPath?: string }) => Promise<{ stop: () => Promise<void> }>;

    const portToUse = 18010 + (process.pid % 1000);
    const server = await start({ port: portToUse });

    // Wait for /health
    let healthy = false;
    for (let i = 0; i < 30; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${portToUse}/health`);
            if (res.ok) {
                healthy = true;
                break;
            }
        } catch (e) { }
        await new Promise((r) => setTimeout(r, 500));
    }
    expect(healthy).toBe(true);

    // Create a memory via the API
    const addRes = await fetch(`http://127.0.0.1:${portToUse}/memory/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "postgres-test-memory" }),
    });

    expect(addRes.ok).toBe(true);
    const added = await addRes.json();
    expect(added).toBeDefined();
    expect(added.id).toBeDefined();

    const id = added.id;

    // Retrieve the memory
    const getRes = await fetch(`http://127.0.0.1:${portToUse}/memory/${id}`);
    expect(getRes.ok).toBe(true);
    const got = await getRes.json();
    expect(got.content).toBe("postgres-test-memory");

    // Cleanup: delete memory
    const delRes = await fetch(`http://127.0.0.1:${portToUse}/memory/${id}`, {
        method: "DELETE",
    });
    expect(delRes.ok).toBe(true);

    await server.stop();
}, { timeout: 120_000 });

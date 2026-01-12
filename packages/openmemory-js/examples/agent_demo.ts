import { MemoryClient } from "../src/client";
import { logger } from "../src/utils/logger";

// Runnable demo script
// Run with: bun examples/agent_demo.ts
async function main() {
    console.log("Initializing Agent Demo...");

    // Connect to local server
    const client = new MemoryClient({ baseUrl: process.env.OM_URL || "http://localhost:8000", token: process.env.OM_API_KEY });

    // Check health
    const isHealthy = await client.health();
    if (!isHealthy) {
        logger.error("Server not reachable. Please start the server first.");
        return;
    }
    console.log("Server connected ✅");

    try {
        // 1. Store Memory
        console.log("Storing user preference...");
        const mem = await client.add("User prefers dark mode and high contrast themes.", {
            tags: ["preference", "ui"],
            metadata: { source: "demo" }
        });
        console.log(`Stored memory: ${mem.id} (${mem.primarySector})`);

        // 2. Search
        console.log("Searching for 'ui'...");
        const results = await client.search("ui preference", { limit: 1 });
        console.log(`Found ${results.length} results. Top result: ${results[0]?.content}`);

        // 3. Temporal Fact
        console.log("Adding temporal fact...");
        const fact = await client.addFact({
            subject: "User",
            predicate: "assigned_role",
            object: "admin",
            confidence: 0.95
        });
        console.log(`Fact created: ${fact.id}`);

    } catch (err) {
        console.error("Demo failed:", err);
    }
}

if (import.meta.main) {
    main().catch(console.error);
}

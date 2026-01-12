
import { MemoryClient } from "../src/client";
import { logger } from "../src/utils/logger";

const client = new MemoryClient({
    baseUrl: "http://localhost:3000",
    // Assumes server is running with no auth or you have a valid token
    // token: "your-api-key" 
});

async function main() {
    console.log("=== Temporal Graph Demo ===");

    // 1. Create Facts
    console.log("\n[1] Creating Facts...");
    const fact1 = await client.addFact({
        subject: "Alice",
        predicate: "works_at",
        object: "TechCorp",
        confidence: 0.9,
        validFrom: new Date("2023-01-01").toISOString()
    });
    console.log("Created Fact 1:", fact1.id);

    const fact2 = await client.addFact({
        subject: "Bob",
        predicate: "works_at",
        object: "TechCorp",
        confidence: 0.8
    });
    console.log("Created Fact 2:", fact2.id);

    // 2. Create an Edge (Relationship)
    console.log("\n[2] Creating Edge (Alice -> manages -> Bob)...");
    const edge = await client.addEdge({
        sourceId: fact1.id,
        targetId: fact2.id,
        relationType: "manages",
        weight: 1.0
    });
    console.log("Created Edge:", edge.id);

    // 3. Update the Edge (e.g., promotion increased weight)
    console.log("\n[3] Updating Edge Weight...");
    await client.updateEdge(edge.id, {
        weight: 0.95,
        metadata: { reason: "Performance Review" }
    });
    console.log("Edge Updated.");

    // 4. Time Travel Query
    console.log("\n[4] Querying History...");
    const history = await client.getSubjectFacts("Alice", undefined, true);
    console.log(`Alice has ${history.length} facts in history.`);

    // 5. Invalidate a Fact (Alice leaves)
    console.log("\n[5] Invalidating Fact 1 (Alice leaves TechCorp)...");
    await client.invalidateFact(fact1.id, new Date().toISOString());
    console.log("Fact Invalidated.");

    // 6. Verify Current State
    const current = await client.getCurrentFact("Alice", "works_at");
    if (!current) {
        console.log("Verified: Alice no longer actively works at TechCorp (Current fact is null).");
    } else {
        console.log("Warning: Alice still has an active fact:", current);
    }
}

main().catch(console.error);

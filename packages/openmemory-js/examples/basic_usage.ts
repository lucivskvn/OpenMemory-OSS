/**
 * @file basic_usage.ts
 * @description Basic example of using the OpenMemory SDK (embedded mode).
 */

import { Memory } from "../src/index";

async function main() {
    console.log("🧠 Initializing OpenMemory (Embedded Mode)...");

    // 1. Initialize Memory Engine
    const mem = new Memory("user-1");
    // const mem = new Memory({ userId: "user-1" }); // Also valid

    // 2. Add Memories
    console.log("\n📝 Adding memories...");
    const m1 = await mem.add("I love coding in TypeScript and Rust.", { tags: ["skills", "preference"] });
    console.log(`Added: ${m1.id}`);

    const m2 = await mem.add("My favorite color is blue.", { tags: ["preference"] });
    console.log(`Added: ${m2.id}`);

    // 3. Search
    console.log("\n🔍 Searching for 'coding'...");
    const results = await mem.search("coding preferences");
    results.forEach((r, i) => {
        console.log(`${i + 1}. [${r.primarySector}] ${r.content} (Score: ${r.score})`);
    });

    // 4. Temporal Facts
    console.log("\n⏳ Adding Temporal Fact...");
    await mem.temporal.add("Alice", "knows", "Bob");
    const history = await mem.temporal.history("Alice");
    console.log("Alice's history:", history.map(h => `${h.predicate} ${h.object}`));

    console.log("\n✅ Done!");
}

main().catch(console.error);

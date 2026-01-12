/**
 * @file ide_plugin_demo.ts
 * @description Simulates an IDE Plugin (e.g., VS Code Extension) interacting with OpenMemory.
 * Demonstrates:
 * 1. Starting a session
 * 2. Sending file context
 * 3. Listening for real-time suggestions via SSE
 */

import { MemoryClient } from "../src/client";

const SERVER_URL = "http://localhost:3000";
const API_KEY = process.env.OM_API_KEY || "om_admin_key"; // Requires Admin scope for firehose subscription

async function main() {
    console.log("🔌 Initializing OpenMemory IDE Plugin Demo...");

    const client = new MemoryClient({
        baseUrl: SERVER_URL,
        token: API_KEY
    });

    // 1. Setup SSE Listener
    console.log("👂 Connecting to Event Stream...");

    const stopListening = client.listen((event) => {
        if (event.type === 'ide_suggestion') {
            console.log("\n💡 [SUGGESTION RECEIVED]:");
            console.log(`Paper Clip says: "${event.data.topPattern.description}"`);
            console.log(`(Confidence: ${event.data.topPattern.salience})`);
        } else if (event.type === 'memory_added') {
            console.log(`\n💾 [MEMORY ADDED]: ${event.data.id}`);
        }
    });

    // 2. Start Session (Simulate opening a project)
    console.log("\n🚀 Starting Session...");
    try {
        const session = await client.startIdeSession({
            projectName: "SuperApp",
            ideName: "VS Beep"
        });
        const sessionId = session.sessionId;
        console.log("✅ Session Started:", sessionId);

        // 3. Simulate Coding (Send Context)
        console.log("\n📝 Sending Code Context...");

        // Simulate user typing a function that looks like a known pattern
        const codeSnippet = `
        // User is writing a quick sort implementation
        function sort(arr) {
            if (arr.length <= 1) return arr;
            const pivot = arr[0];
            const left = []; 
            const right = [];
            // ...
        }
        `;

        await client.sendIdeEvent({
            sessionId: sessionId,
            eventType: "file_change",
            fileParams: {
                filePath: "/src/utils/sort.ts",
                content: codeSnippet,
            },
        });
        console.log("✅ Context Sent. Waiting for suggestions...");

        // Wait to receive events
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // 4. End Session
        console.log("\n🛑 Ending Session...");
        const result = await client.endIdeSession(sessionId);
        console.log("✅ Session Ended. Summary:", result.summaryMemoryId);

    } catch (error) {
        console.error("❌ Error:", error);
    } finally {
        stopListening();
    }
}

main().catch(console.error);

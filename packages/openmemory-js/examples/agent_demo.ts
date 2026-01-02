import { OpenMemoryTools } from "../src/ai/agents";

// Mock interaction demo
async function main() {
    console.log("Initializing Agent Tools...");
    const tools = new OpenMemoryTools("agent_user_01");

    // 1. Definition check
    const defs = tools.getFunctionDefinitions();
    console.log(`Tools available: ${defs.map(d => d.name).join(", ")}`);

    try {
        // 2. Mock Store (requires DB connection, which might fail without server context, 
        //    but verifies TS compilation and integrity)
        console.log("Storing memory...");
        // const res = await tools.store("User prefers dark mode.", ["preference"]);
        // console.log("Stored:", res);
        console.log("(Skipping actual DB write to avoid setup overhead)");

    } catch (err) {
        console.error("Agent op failed:", err);
    }
}

if (import.meta.main) {
    main().catch(console.error);
}

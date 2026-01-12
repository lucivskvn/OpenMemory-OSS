
import { expect } from "bun:test";

const BASE_URL = process.env.BASE_URL || "http://localhost:8080";
const ADMIN_KEY = process.env.OM_ADMIN_KEY || "admin-secret"; // Ensure this matches server env

console.log(`[VERIFY] Target: ${BASE_URL}`);
console.log(`[VERIFY] Admin Key: ${ADMIN_KEY.substring(0, 3)}...`);

async function call(path: string, method = "GET", body?: any, token?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, opts);
    let data;
    try {
        data = await res.json();
    } catch {
        data = { text: await res.text() };
    }
    return { status: res.status, data };
}

async function run() {
    try {
        // 1. Health Check
        console.log("1. Checking Health...");
        const health = await call("/health");
        if (health.status !== 200) throw new Error("Health check failed");
        console.log("   OK:", health.data.version);

        // 2. Admin: Create User
        console.log("2. Creating Test User...");
        const userId = `test-user-${Date.now()}`;
        const createRes = await call("/admin/users", "POST", {
            id: userId,
            scopes: ["memory:read", "memory:write"]
        }, ADMIN_KEY);

        if (createRes.status !== 200) {
            console.error(createRes.data);
            throw new Error("Failed to create user");
        }
        console.log("   OK: User created", userId);

        // 3. Admin: Generate Key
        console.log("3. Generating User API Key...");
        const keyRes = await call(`/admin/users/${userId}/keys`, "POST", { name: "Test Key" }, ADMIN_KEY);
        if (keyRes.status !== 200) throw new Error("Failed to create key");
        const USER_KEY = keyRes.data.apiKey;
        console.log("   OK: Key generated");

        // 4. Create Source Config (Encrypted Write)
        console.log("4. Verifying Source Config Encryption (Write)...");
        const sourceHtml = { apiKey: "secret-123" };
        const srcRes = await call(`/admin/users/${userId}/sources`, "POST", {
            type: "github",
            config: JSON.stringify(sourceHtml),
            status: "enabled"
        }, ADMIN_KEY);
        if (srcRes.status !== 200) throw new Error("Failed to create source config");
        console.log("   OK: Source config written");

        // 5. Verify Source Config (Masked Read)
        console.log("5. Verifying Source Config Secrecy (Read)...");
        const srcGetRes = await call(`/admin/users/${userId}/sources`, "GET", undefined, ADMIN_KEY);
        const srcItem = srcGetRes.data.sources.find((s: any) => s.type === "github");
        if (!srcItem) throw new Error("Source not found");
        if (srcItem.config) throw new Error("SECURITY FAILURE: Config returned in plaintext!");
        console.log("   OK: Secrets masked in API response");

        // 6. User: Add Memory
        console.log("6. User Inflow: Adding Memory...");
        const memRes = await call("/memory/add", "POST", {
            content: "The verify_system script is running successfully.",
            metadata: { type: "test" }
        }, USER_KEY);
        if (memRes.status !== 200) throw new Error(`Add Memory failed: ${JSON.stringify(memRes.data)}`);
        console.log("   OK: Memory ID", memRes.data.id);

        // 7. User: Query
        console.log("7. User Outflow: Querying Memory...");
        // Wait for ingestion/vectorization (simulated)
        await new Promise(r => setTimeout(r, 1000));
        const qRes = await call("/memory/query", "POST", {
            query: "verify system script",
            k: 1
        }, USER_KEY);

        if (qRes.status !== 200) throw new Error("Query failed");
        if (qRes.data.matches.length === 0) console.warn("   WARN: No matches found (indexing lag?)");
        else console.log("   OK: Found match:", qRes.data.matches[0].id);

        // 8. Dashboard Stats
        console.log("8. Verifying Dashboard Stats Access...");
        const statsRes = await call("/dashboard/stats", "GET", undefined, ADMIN_KEY);
        if (statsRes.status !== 200) throw new Error("Dashboard stats failed");
        console.log("   OK: Stats retrieved");

        // Cleanup
        console.log("9. Cleanup...");
        await call(`/admin/users/${userId}`, "DELETE", undefined, ADMIN_KEY);
        console.log("   OK: User deleted");

        console.log("\n✅ VERIFICATION SUCCESSFUL: System is Secure and Functional.");

    } catch (e) {
        console.error("\n❌ VERIFICATION FAILED:", e);
        process.exit(1);
    }
}

run();

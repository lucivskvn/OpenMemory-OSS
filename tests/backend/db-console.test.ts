import { test, expect } from "bun:test";
import path from "path";

test("DB console prefix appears when OM_DB_CONSOLE and user-scope warn enabled", async () => {
    // Capture console outputs
    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: any[]) => {
        logs.push(args.map(String).join(" "));
    };
    console.warn = (...args: any[]) => {
        logs.push(args.map(String).join(" "));
    };
    console.error = (...args: any[]) => {
        logs.push(args.map(String).join(" "));
    };

    // Enable console-prefixed DB messages and user-scope warnings
    process.env.OM_DB_CONSOLE = "true";
    process.env.OM_DB_USER_SCOPE_WARN = "true";
    process.env.OM_DB_PATH = ":memory:";
    process.env.OM_METADATA_BACKEND = "sqlite";

    try {
        const mod: any = await import("../../backend/src/core/db");
        // Call initDb before reading live bindings from the module namespace.
        await mod.initDb();
        const q = mod.q;
        // Trigger a query that references user_id without supplying it
        // get_vec will execute SQL containing 'user_id' and pass nulls for the user_id params.
        await q.get_vec.get("no-such-id", "semantic");

        // Give a small tick for any async console writes
        await new Promise((r) => setTimeout(r, 20));

        const found = logs.some((l) => l.includes("[DB]") || l.includes("DB query referencing user_id"));
        expect(found).toBe(true);
    } finally {
        // Restore console
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
    }
});

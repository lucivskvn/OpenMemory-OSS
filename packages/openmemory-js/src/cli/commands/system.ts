import { CliFlags } from "../types";
import { ensureClient } from "../utils";
import { MaintLogEntry } from "../../core/types/system";

export const systemCommands = {
    stats: async (args: string[], flags: CliFlags) => {
        const api = await ensureClient(flags);
        const s = await api.stats();
        console.log(JSON.stringify(s, null, 2));
    },

    logs: async (args: string[], flags: CliFlags) => {
        const api = await ensureClient(flags);
        const limit = flags.limit ? parseInt(flags.limit) : 100;
        const userId = flags.userId;

        console.log(`Fetching last ${limit} logs...`);
        try {
            // System Client is on api.system, but ensureClient returns MemoryClient which has .system accessor
            const res = await api.system.getLogs(limit, userId);
            if (res.success) {
                if (res.logs.length === 0) {
                    console.log("No logs found.");
                } else {
                    console.table(res.logs.map((l: MaintLogEntry) => ({
                        Timestamp: new Date(l.ts).toISOString(),
                        Op: l.op,
                        Status: l.status,
                        User: l.userId || "System",
                        Details: l.details
                    })));
                }
            } else {
                console.error("Failed to fetch logs.");
            }
        } catch (e: any) {
            console.error("Error fetching logs:", e.message);
        }
    },

    doctor: async (args: string[], flags: CliFlags) => {
        console.log("Checking system health...");
        const api = await ensureClient(flags);
        // ensureClient handles remote vs local logic internally
        if (flags.host) {
            console.log(`\x1b[32m✔\x1b[0m Connected to Remote Host: ${flags.host}`);
            const st = await api.stats();
            console.log(`\x1b[32m✔\x1b[0m Remote Stats: ${st.memories} memories, ${st.vectors} vectors.`);
        } else {
            const st = await api.stats();
            console.log(`\x1b[32m✔\x1b[0m Local Database Initialized.`);
            console.log(`stats: ${JSON.stringify(st)}`);
            // Extra local checks
            const { env } = await import("../../core/cfg");
            console.log(`Config: DB=${env.dbPath}, Vector=${env.vectorBackend}`);
        }
    },

    setup: async (args: string[], flags: CliFlags) => {
        const token = args[0];
        if (!token) throw new Error("Token required");

        try {
            const port = process.env.PORT || 8080;
            const url = `http://localhost:${port}/setup/verify`;

            console.log(`Connecting to ${url}...`);

            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, userId: 'admin' })
            });

            if (!res.ok) {
                const err = await res.json() as { error?: string, message?: string };
                throw new Error(err.message || err.error || `Setup failed with status ${res.status}`);
            }

            const data = await res.json() as { success: boolean, apiKey: string, userId: string };
            console.log("\n✅ Setup Successful!");
            console.log(`User: ${data.userId}`);
            console.log(`API Key: ${data.apiKey}`);
            console.log("\nSave this key! It will not be shown again.");
        } catch (error: unknown) {
            console.error("Setup failed:", error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    },

    wipe: async (args: string[], flags: CliFlags) => {
        if (flags.host) throw new Error("Remote wipe not supported via CLI.");
        const readline = await import("readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ans = await rl.question("WARNING: This will wipe ALL data. Type 'CONFIRM' to proceed: ");
        rl.close();
        if (ans !== "CONFIRM") {
            console.log("Aborted.");
            return;
        }
        const api = await ensureClient(flags);
        await api.wipe();
        console.log("Database wiped.");
    },

    reflect: async (args: string[], flags: CliFlags) => {
        const api = await ensureClient(flags);
        const userId = flags.userId;
        if (!userId && !flags.host) {
            console.warn("\x1b[33m[WARN] No userId provided for reflection. Defaulting to system-wide if admin.\x1b[0m");
        }
        console.log(`Triggering memory reflection for ${userId || "all"}...`);
        const res = await api.train(userId || "system");
        if (res) {
            console.log("\x1b[32m✔\x1b[0m Reflection triggered successfully.");
        } else {
            console.error("Failed to trigger reflection.");
        }
    }
};

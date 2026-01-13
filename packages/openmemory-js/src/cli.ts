#!/usr/bin/env bun
/**
 * @file cli.ts
 * @module CLI
 * @description Standard Command Line Interface for OpenMemory.
 * Provides entry points for system management, ingestion, status checks, and data manipulation.
 * Supports `mcp` server startup via stdio for IDE integration.
 */

import { MemoryClient } from "./client";
import { closeDb, q, TABLES } from "./core/db";
import { Memory } from "./core/memory";
import { runMigrations } from "./core/migrate";
import { LocalAdapter, RemoteAdapter, CliMemoryInterface } from "./cli_adapter";

// --- Types & Interfaces ---

interface CliFlags {
    user_id?: string;
    userId?: string;
    type?: string;
    limit?: string;
    host?: string;
    tags?: string;
    sector?: string;
    min_salience?: string;
    force?: string;
    namespace?: string;
    rate?: string;
    [key: string]: string | undefined;
}

// --- Global State ---
let client: CliMemoryInterface | null = null;
let isRemote = false;

// --- Helper Functions ---

async function getExistingTables(): Promise<Set<string>> {
    try {
        const tables = await q.getTables.all();
        return new Set(tables.map((t: { name: string }) => t.name.replace(/"/g, "")));
    } catch {
        return new Set();
    }
}

async function ensureClient(flags: CliFlags): Promise<CliMemoryInterface> {
    if (client) return client;

    const host = flags.host || process.env.OM_HOST;

    if (host) {
        // Remote Mode
        isRemote = true;
        const token = process.env.OM_API_KEY || "";
        const c = new MemoryClient({ baseUrl: host, token });

        // Quick health check
        try {
            const ok = await c.health();
            if (!ok) console.warn("\x1b[33mWarning: Remote host reported unhealthy.\x1b[0m");
        } catch (e) {
            console.warn(`\x1b[33mWarning: Could not connect to ${host}. Operations might fail.\x1b[0m`);
        }

        client = new RemoteAdapter(c);
        // console.log(`\x1b[32m[Remote Mode]\x1b[0m Connected to ${host}`);
    } else {
        // Local Mode
        isRemote = false; // ensure false
        // Initialize Core Memory
        const mem = new Memory(flags.user_id || flags.userId);
        client = new LocalAdapter(mem);
    }
    return client;
}

function printHelp() {
    console.log(`
\x1b[1;35mOpenMemory (opm) CLI\x1b[0m
Usage: opm <command> [args] [--host <url>] [--user_id <id>]

Core Commands:
  \x1b[33madd\x1b[0m <text>          Add memory
  \x1b[33msearch\x1b[0m <query>      Search memories
  \x1b[33mdelete\x1b[0m <id>         Delete memory
  \x1b[33mupdate\x1b[0m <id> <text>  Update memory
  \x1b[33mstats\x1b[0m               System stats
  \x1b[33mdoctor\x1b[0m              Health check
  \x1b[33mingest-url\x1b[0m <url>    Ingest webpage
  \x1b[33mingest\x1b[0m <source>     Ingest source (github, notion, etc)

Temporal Commands:
  \x1b[33madd-fact\x1b[0m <s> <p> <o>
  \x1b[33msearch-facts\x1b[0m <pattern>
  \x1b[33mtimeline\x1b[0m <s>
  \x1b[33mcompare\x1b[0m <s> [t1] [t2]

Maintenance (Local Only):
  \x1b[33mmigrate\x1b[0m             Run DB migrations
  \x1b[33mstart\x1b[0m               Start API Server
  \x1b[33mmcp start\x1b[0m           Start MCP Server (Stdio)
  \x1b[33msetup\x1b[0m <token>       Init Admin Key
  \x1b[33mwipe\x1b[0m                Wipe DB
  \x1b[33mingest-av\x1b[0m <file>    Ingest Audio/Video

Flags:
  --host <url>       Remote server (Standard: http://localhost:8080)
  --user_id <id>     Target User
  --limit <n>        Max results

Advanced Commands:
  \x1b[33mdelete-all\x1b[0m --user_id <id>     Delete ALL memories for user
  \x1b[33mtrain\x1b[0m <user>          Train/Retrain Classifier
  \x1b[33mlisten\x1b[0m              Listen for SSE events
  \x1b[33mcompress\x1b[0m <text>     Test compression
`);
}

// --- Main Execution ---

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    // Help
    if (!command || command === "--help" || command === "-h") {
        printHelp();
        process.exit(0);
    }

    // Parse Flags
    const flags: CliFlags = {};
    const commandArgs: string[] = [];
    for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith("--")) {
            const key = args[i].substring(2);
            const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "true";
            flags[key] = val;
            if (val !== "true") i++;
        } else {
            commandArgs.push(args[i]);
        }
    }

    // --- Local-Only Commands (Pre-Client Init) ---

    try {
        if (command === "migrate") {
            if (flags.host) throw new Error("Migrations can only be run locally.");
            await runMigrations();
            console.log("Migrations completed.");
            return;
        }

        if (command === "start") {
            await import("./server/index");
            return;
        }

        if (command === "mcp") {
            const sub = commandArgs[0];
            if (sub === "start" || sub === "stdio") {
                console.log(`\x1b[36mStarting MCP Server (Stdio)...\x1b[0m`);
                const { startMcpStdio } = await import("./ai/mcp");
                await startMcpStdio(); // Keeps process alive
            } else {
                console.error("Usage: opm mcp start");
            }
            return;
        }

        if (command === "setup") {
            const token = commandArgs[0];
            if (!token) throw new Error("Token required");

            try {
                // opm setup <token> is used to claim a running instance.
                // Since tokens are in-memory on the server, we must hit the API.
                // We default to localhost as this is a local setup command.
                const port = process.env.PORT || 3000;
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
            return;
        }

        // --- Initialize Client ---
        const api = await ensureClient(flags);
        const userId = flags.user_id || flags.userId;

        switch (command) {
            case "add": {
                if (commandArgs.length === 0) throw new Error("Content required");
                const res = await api.add(commandArgs[0], {
                    tags: flags.tags ? flags.tags.split(",") : [],
                    userId,
                    primarySector: flags.sector
                });
                console.log(JSON.stringify(res, null, 2));
                break;
            }

            case "search": {
                if (commandArgs.length === 0) throw new Error("Query required");
                const res = await api.search(commandArgs[0], {
                    limit: parseInt(flags.limit || "10"),
                    userId,
                    type: flags.type,
                    minSalience: flags.min_salience ? parseFloat(flags.min_salience) : undefined
                });

                // Pretty print for CLI
                if (Array.isArray(res)) {
                    console.log(`\x1b[36mFound ${res.length} matches:\x1b[0m\n`);
                    res.forEach((h: any, idx: number) => {
                        console.log(`\x1b[1m${idx + 1}.\x1b[0m [${h.primarySector || '?'}] ${h.content?.slice(0, 100)}${h.content?.length > 100 ? "..." : ""}`);
                        console.log(`   \x1b[90mID: ${h.id} | Score: ${h.score?.toFixed(4)}\x1b[0m\n`);
                    });
                } else {
                    console.log(JSON.stringify(res, null, 2));
                }
                break;
            }

            case "stats": {
                const s = await api.stats();
                console.log(JSON.stringify(s, null, 2));
                break;
            }

            case "delete": {
                if (!commandArgs[0]) throw new Error("ID required");
                const res = await api.delete(commandArgs[0]);
                console.log(res ? "Deleted." : "Not found or failed.");
                break;
            }

            case "update": {
                if (commandArgs.length < 2) throw new Error("ID and Content required");
                const res = await api.update(commandArgs[0], commandArgs[1]);
                console.log(JSON.stringify(res, null, 2));
                break;
            }

            case "ingest-url": {
                if (!commandArgs[0]) throw new Error("URL required");
                const res = await api.ingestUrl(commandArgs[0], { userId });
                console.log(JSON.stringify(res, null, 2));
                break;
            }

            case "ingest": {
                if (!commandArgs[0]) throw new Error("Source name required");
                const srcName = commandArgs[0];
                const src = await api.source(srcName);

                if (!isRemote) {
                    // Local Interactive
                    if (src.connect && typeof src.connect === 'function') {
                        await src.connect();
                    }
                    console.log("Starting local ingestion...");
                    const stats = await src.ingestAll({});
                    console.log("Ingestion complete:", stats);
                } else {
                    // Remote Trigger
                    console.log(`Triggering remote ingestion for ${srcName}...`);
                    const res = await src.ingestAll({});
                    console.log("Remote result:", res);
                }
                break;
            }
            case "train": {
                const targetUser = commandArgs[0] || userId;
                if (!targetUser) throw new Error("User ID required: opm train [user_id]");
                console.log(`\x1b[36m[TRAIN] Starting classifier training for: ${targetUser}...\x1b[0m`);

                const model = await api.train(targetUser);
                if (model && (model.version || model.success)) {
                    console.log(`\x1b[32m[TRAIN] Success!\x1b[0m Model updated (v${model.version || '?'})`);
                } else {
                    console.log(`\x1b[33m[TRAIN] Check logs/output. Result: ${JSON.stringify(model)}\x1b[0m`);
                }
                break;
            }
            case "delete-all": {
                if (!userId && !flags.force) {
                    const readline = await import("readline/promises");
                    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                    const ans = await rl.question("WARNING: No user specified. This will delete ALL memories. Type 'CONFIRM' to proceed: ");
                    rl.close();
                    if (ans !== "CONFIRM") {
                        console.log("Aborted.");
                        break;
                    }
                }
                const count = await api.deleteAll(userId);
                console.log(`Deleted ${count} memories.`);
                break;
            }

            case "wipe": {
                if (isRemote) throw new Error("Remote wipe not supported via CLI.");
                const readline = await import("readline/promises");
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                const ans = await rl.question("WARNING: This will wipe ALL data. Type 'CONFIRM' to proceed: ");
                rl.close();
                if (ans !== "CONFIRM") {
                    console.log("Aborted.");
                    break;
                }
                await api.wipe();
                console.log("Database wiped.");
                break;
            }

            case "doctor": {
                console.log("Checking system health...");
                if (isRemote) {
                    console.log(`\x1b[32m✔\x1b[0m Connected to Remote Host: ${flags.host || process.env.OM_HOST}`);
                    const st = await api.stats();
                    console.log(`\x1b[32m✔\x1b[0m Remote Stats: ${st.memories} memories, ${st.vectors} vectors.`);
                } else {
                    const st = await api.stats();
                    console.log(`\x1b[32m✔\x1b[0m Local Database Initialized.`);
                    console.log(`stats:`, st);

                    // Run extra local checks?
                    const { env } = await import("./core/cfg");
                    console.log(`Config: DB=${env.dbPath}, Vector=${env.vectorBackend}`);
                }
                break;
            }

            // --- Temporal ---
            case "add-fact": {
                if (commandArgs.length < 3) throw new Error("S, P, O required");
                const res = await api.temporal.add(commandArgs[0], commandArgs[1], commandArgs[2]);
                console.log(JSON.stringify(res, null, 2));
                break;
            }
            case "search-facts": {
                if (!commandArgs[0]) throw new Error("Pattern required");
                const res = await api.temporal.search(commandArgs[0], { type: flags.type });
                console.log(JSON.stringify(res, null, 2));
                break;
            }
            case "timeline": {
                if (!commandArgs[0]) throw new Error("Subject required");
                const res = await api.temporal.history(commandArgs[0]);
                console.log(JSON.stringify(res, null, 2));
                break;
            }
            case "compare": {
                if (!commandArgs[0]) throw new Error("Subject required");
                const t1 = commandArgs[1] ? new Date(commandArgs[1]) : new Date(Date.now() - 86400000);
                const t2 = commandArgs[2] ? new Date(commandArgs[2]) : new Date();
                const res = await api.temporal.compare(commandArgs[0], t1, t2);
                console.log(JSON.stringify(res, null, 2));
                break;
            }

            // --- Local Only Fallbacks / Misc ---

            case "ingest-av": {
                if (isRemote) throw new Error("AV Ingest is local-only for now.");
                const filePath = commandArgs[0];
                if (!filePath) throw new Error("File path required");

                const fs = await import("fs/promises");
                const buffer = await fs.readFile(filePath);
                // Guess mime
                let contentType = "audio/mp3";
                if (filePath.endsWith(".wav")) contentType = "audio/wav";
                if (filePath.endsWith(".webm")) contentType = "video/webm";

                console.log("Analyzing content...");
                const { ingestDocument } = await import("./ops/ingest");
                const ingestRes = await ingestDocument(contentType, buffer, { sourceFile: filePath, ingestType: "av-cli" }, {}, userId || null);
                console.log(JSON.stringify(ingestRes, null, 2));
                break;
            }

            case "compress": {
                if (isRemote) throw new Error("Compression test is local-only.");
                if (!commandArgs[0]) throw new Error("Text required");
                const { compressionEngine } = await import("./ops/compress");
                const cResult = compressionEngine.auto(commandArgs[0]);
                console.log(JSON.stringify(cResult, null, 2));
                break;
            }

            case "listen": {
                const host = flags.host || "http://localhost:3000";
                const token = flags.userId; // Abuse userId as token if needed
                console.log(`\x1b[36mListening for events on ${host}...\x1b[0m`);

                const realTimeClient = new MemoryClient({ baseUrl: host, token });
                realTimeClient.listen((event: any) => {
                    const ts = new Date(event.timestamp).toLocaleTimeString();
                    console.log(`[${ts}] ${event.type} ->`, event.data);
                });
                await new Promise(() => { }); // Wait forever
                break;
            }

            default:
                console.error(`Unknown command: ${command}`);
                printHelp();
                process.exit(1);
        }

    } catch (e: any) {
        console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
        if (!flags.host) {
            // make sure to close if local
            // but closeDb is async
        }
        process.exit(1);
    } finally {
        if (!isRemote) {
            await closeDb();
        }
    }
}

main().catch(console.error);

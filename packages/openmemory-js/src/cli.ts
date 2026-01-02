#!/usr/bin/env bun
/**
 * openmemory (opm) CLI - production-grade management tool
 * 
 * commands:
 * - migrate: run database migrations
 * - add <text>: add a new memory
 * - search <query>: search memories
 * - ingest <source> <filters...>: ingest from external source
 * - wipe: clear all data
 */

import { run_async, all_async, q, close_db } from "./core/db";
import { Memory } from "./core/memory";
import { run_migrations } from "./core/migrate";

// Helper to check table existence (now DB-agnostic)
async function get_existing_tables(): Promise<Set<string>> {
    try {
        const tables = await q.get_tables.all();
        return new Set(tables.map((t) => t.name));
    } catch {
        return new Set();
    }
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === "--help" || command === "-h") {
        console.log(`
\x1b[1;35mOpenMemory (opm) CLI\x1b[0m
Usage: opm <command> [args]

Commands:
  \x1b[33mmigrate\x1b[0m             Run database migrations
  \x1b[33madd\x1b[0m <text>          Add a new memory record
  \x1b[33msearch\x1b[0m <query>      Search memories using hybrid retrieval
  \x1b[33mingest\x1b[0m <source>     Ingest from: github, notion, google_drive, etc.
  \x1b[33mstats\x1b[0m               View database statistics
  \x1b[33mwipe\x1b[0m                Clear all data (\x1b[31mdestructive\x1b[0m)

Options:
  --user_id <id>      Target user identity (default: anonymous)
  --limit <n>         Search result limit (default: 10)
        `);
        return;
    }

    const mem = new Memory();
    const flags: Record<string, string> = {};
    const positional: string[] = [];

    // simple parser
    for (let i = 1; i < args.length; i++) {
        if (args[i].startsWith("--")) {
            flags[args[i].slice(2)] = args[i + 1];
            i++;
        } else {
            positional.push(args[i]);
        }
    }

    const user_id = flags.user_id || "anonymous";

    try {
        switch (command) {
            case "migrate":
                await run_migrations();
                break;

            case "add":
                if (!positional[0]) throw new Error("Content required: opm add \"text here\"");
                const res = await mem.add(positional[0], { user_id, ...flags });
                console.log(`\x1b[32mAdded memory:\x1b[0m ${res.id}`);
                break;

            case "search":
                if (!positional[0]) throw new Error("Query required: opm search \"query here\"");
                const hits = await mem.search(positional[0], {
                    user_id,
                    limit: parseInt(flags.limit || "10")
                });
                console.log(`\x1b[36mFound ${hits.length} matches:\x1b[0m\n`);
                hits.forEach((h: any, idx: number) => {
                    console.log(`\x1b[1m${idx + 1}.\x1b[0m [${h.primary_sector}] ${h.content.slice(0, 100)}${h.content.length > 100 ? '...' : ''}`);
                    console.log(`   \x1b[90mID: ${h.id} | Salience: ${h.salience?.toFixed(4)}\x1b[0m\n`);
                });
                break;

            case "ingest":
                const source_name = positional[0];
                if (!source_name) throw new Error("Source required: opm ingest <github|notion|etc>");
                const filters: Record<string, any> = {};
                positional.slice(1).forEach(p => {
                    const [k, v] = p.split("=");
                    if (k && v) filters[k] = v;
                });
                console.log(`\x1b[35m[INGEST]\x1b[0m Starting ${source_name} ingestion...`);
                const source = await mem.source(source_name);
                await source.connect();
                const ids = await source.ingest_all(filters);
                console.log(`\x1b[32m[INGEST] Success:\x1b[0m Ingested ${ids.length} items`);
                break;

            case "stats":
                const counts = await all_async(`
                    SELECT 
                        (SELECT count(*) FROM memories) as memories,
                        (SELECT count(*) FROM vectors) as vectors,
                        (SELECT count(*) FROM waypoints) as relations
                `);
                console.table(counts[0]);
                break;

            case "wipe":
                console.log("\x1b[31;1m%s\x1b[0m", "WARNING: This will delete EVERYTHING in the database.");
                console.log("Press Enter to continue, or Ctrl+C to abort...");
                await new Promise(resolve => process.stdin.once('data', resolve));
                await mem.wipe();
                console.log("\x1b[32mDatabase wiped.\x1b[0m");
                process.exit(0);
                break;

            default:
                console.error(`Unknown command: ${command}`);
                process.exit(1);
        }
    } catch (err: any) {
        console.error(`\x1b[31mError:\x1b[0m ${err.message}`);
        await close_db(); // Ensure DB is closed
        process.exit(1);
    } finally {
        await close_db();
        process.exit(0);
    }
}

main();


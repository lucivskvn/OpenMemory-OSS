
/**
 * @file src/cli/index.ts
 * @module CLI
 * @description Main entry point for the OpenMemory CLI.
 * Dispatches commands to specific handlers in the `commands/` directory.
 */

import { parseArgs } from "./parser";
import { printHelp } from "./utils";
import { coreCommands } from "./commands/core";
import { systemCommands } from "./commands/system";
import { temporalCommands } from "./commands/temporal";
import { ingestCommands } from "./commands/ingest";
import { runMigrations } from "../core/migrate";

// Semver comparator: 1 if a > b, -1 if a < b, 0 if equal
function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}
import { closeDb } from "../core/db";
import { CliFlags } from "./types";

// Combine all commands
const allCommands: Record<string, (args: string[], flags: CliFlags) => Promise<void>> = {
    ...coreCommands,
    ...systemCommands,
    ...temporalCommands,
    ...ingestCommands
};

export async function main() {
    // Silence info logs to prevent polluting stdout (which is used for JSON output)
    const { configureLogger } = await import("../utils/logger");
    configureLogger({ logLevel: "warn" });

    const { command, args, flags } = parseArgs(process.argv.slice(2));

    // Special cases that don't fit the standard pattern easily or need early exit
    if (!command || flags.help === "true" || command === "--help" || command === "-h") {
        printHelp();
        process.exit(0);
    }

    // Migration is special (local maintenance)
    if (command === "migrate") {
        if (flags.host) throw new Error("Migrations can only be run locally.");
        
        const subCommand = args[0];
        
        if (subCommand === "rollback") {
            const targetVersion = args[1];
            if (!targetVersion) {
                console.error("Usage: migrate rollback <version>");
                process.exit(1);
            }
            
            const { rollbackToVersion } = await import("../core/migrate");
            await rollbackToVersion(targetVersion);
            console.log(`Rollback to version ${targetVersion} completed.`);
        } else if (subCommand === "validate") {
            const { validateDataIntegrity } = await import("../core/migrate");
            const isValid = await validateDataIntegrity();
            if (isValid) {
                console.log("✅ Data integrity validation passed.");
            } else {
                console.error("❌ Data integrity validation failed.");
                process.exit(1);
            }
        } else if (subCommand === "status") {
            const { getCurrentVersion, listMigrations } = await import("../core/migrate");
            const currentVersion = await getCurrentVersion();
            const migrations = listMigrations();
            
            console.log(`Current database version: ${currentVersion || "none"}`);
            console.log("\nAvailable migrations:");
            for (const m of migrations) {
                const status = currentVersion && compareVersions(m.version, currentVersion) <= 0 ? "✅" : "⏳";
                const rollback = m.hasRollback ? "🔄" : "❌";
                const integrity = m.hasIntegrityChecks ? "🔍" : "❌";
                console.log(`  ${status} ${m.version} - ${m.desc} (Rollback: ${rollback}, Integrity: ${integrity})`);
            }
        } else if (subCommand === "list") {
            const { listMigrations } = await import("../core/migrate");
            const migrations = listMigrations();
            
            console.log("Available migrations:");
            for (const m of migrations) {
                console.log(`  ${m.version} - ${m.desc}`);
                console.log(`    Rollback support: ${m.hasRollback ? "Yes" : "No"}`);
                console.log(`    Integrity checks: ${m.hasIntegrityChecks ? "Yes" : "No"}`);
            }
        } else {
            // Default: run migrations
            await runMigrations();
            console.log("Migrations completed.");
            
            // Validate integrity after migration
            const { validateDataIntegrity } = await import("../core/migrate");
            const isValid = await validateDataIntegrity();
            if (isValid) {
                console.log("✅ Data integrity validation passed.");
            } else {
                console.warn("⚠️  Data integrity validation failed after migration.");
            }
        }
        
        process.exit(0);
    }

    if (command === "start") {
        await import("../server/index");
        return; // Server keeps running
    }

    if (command === "mcp") {
        const sub = args[0];
        if (sub === "start" || sub === "stdio") {
            console.log(`\x1b[36mStarting MCP Server (Stdio)...\x1b[0m`);
            const { startMcpStdio } = await import("../ai/mcp");
            await startMcpStdio();
            // Keeps process alive
            return;
        } else {
            console.error("Usage: opm mcp start");
            process.exit(1);
        }
    }

    // Security - Rotate Keys
    if (command === "security" && args[0] === "rotate-keys") {
        if (flags.host) throw new Error("Key rotation is a server-side maintenance operation. Run locally.");
        const { rotateKeys } = await import("../ops/keyRotation");
        console.log("[SECURITY] Initiating key rotation...");
        // We need to resolve userId if not provided? rotateKeys handles that internally or we pass flags
        const res = await rotateKeys({
            userId: flags.userId,
            batchSize: flags.limit ? parseInt(flags.limit) : 100
        });
        console.log("[SECURITY] Rotation complete.", res);
        process.exit(0);
    }

    if (command === "listen") {
        const host = flags.host || "http://localhost:8080";
        const token = flags.token || flags.apiKey;
        if (!token && flags.userId) {
            console.warn("\x1b[33m[WARN] Using userId as token. Please use --token or --apiKey instead.\x1b[0m");
        }
        const effectiveToken = token || flags.userId || "";

        console.log(`\x1b[36mListening for events on ${host}...\x1b[0m`);
        const { MemoryClient } = await import("../client");

        const realTimeClient = new MemoryClient({ baseUrl: host, token: effectiveToken });
        realTimeClient.listen((event: any) => {
            const ts = new Date(event.timestamp).toLocaleTimeString();
            console.log(`[${ts}] ${event.type} ->`, event.data);
        });
        await new Promise(() => { }); // Wait forever
        return;
    }

    // Compression Test
    if (command === "compress") {
        if (flags.host) throw new Error("Compression test is local-only.");
        if (!args[0]) throw new Error("Text required");
        const { compressionEngine } = await import("../ops/compress");
        const cResult = compressionEngine.auto(args[0]);
        console.log(JSON.stringify(cResult, null, 2));
        process.exit(0);
    }

    // General Command Dispatch
    try {
        const handler = allCommands[command];
        if (handler) {
            await handler(args, flags);
        } else {
            console.error(`Unknown command: ${command}`);
            printHelp();
            process.exit(1);
        }
    } catch (e: any) {
        console.error(`\x1b[31mError:\x1b[0m ${e.message}`);
        process.exit(1);
    } finally {
        // If we get here and we are not in a long-running process (like listen/start/mcp),
        // we should try to close the DB if it was opened locally.
        if (!flags.host) {
            try {
                await closeDb();
            } catch { }
        }
        
        // Force exit for commands that should terminate
        if (!["start", "listen", "mcp"].includes(command)) {
            process.exit(0);
        }
    }
}

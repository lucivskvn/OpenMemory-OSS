#!/usr/bin/env bun
/**
 * @file Test Artifacts Cleanup Script
 * Standalone script to clean up test artifacts from the OpenMemory codebase.
 * Can be run manually or as part of CI/CD pipelines.
 */

import { cleanupTestArtifacts } from "../src/utils/testCleanup";
import { logger } from "../src/utils/logger";

interface ScriptOptions {
    dryRun: boolean;
    databases: boolean;
    logs: boolean;
    nodeModules: boolean;
    verbose: boolean;
    help: boolean;
}

function parseArgs(): ScriptOptions {
    const args = process.argv.slice(2);
    const options: ScriptOptions = {
        dryRun: false,
        databases: true,
        logs: true,
        nodeModules: false,
        verbose: false,
        help: false
    };

    for (const arg of args) {
        switch (arg) {
            case '--dry-run':
            case '-n':
                options.dryRun = true;
                break;
            case '--no-databases':
                options.databases = false;
                break;
            case '--no-logs':
                options.logs = false;
                break;
            case '--node-modules':
                options.nodeModules = true;
                break;
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                console.warn(`Unknown option: ${arg}`);
        }
    }

    return options;
}

function printHelp(): void {
    console.log(`
OpenMemory Test Artifacts Cleanup Script

Usage: bun scripts/cleanup-test-artifacts.ts [options]

Options:
  --dry-run, -n         Show what would be deleted without actually deleting
  --no-databases        Skip database file cleanup (*.db, *.sqlite, etc.)
  --no-logs            Skip log file cleanup (*.log, *.txt)
  --node-modules       Include node_modules test artifacts cleanup
  --verbose, -v        Enable verbose logging
  --help, -h           Show this help message

Examples:
  bun scripts/cleanup-test-artifacts.ts                    # Clean databases and logs
  bun scripts/cleanup-test-artifacts.ts --dry-run          # Preview what would be deleted
  bun scripts/cleanup-test-artifacts.ts --node-modules     # Include node_modules cleanup
  bun scripts/cleanup-test-artifacts.ts --no-databases     # Only clean logs
`);
}

async function main(): Promise<void> {
    const options = parseArgs();

    if (options.help) {
        printHelp();
        process.exit(0);
    }

    if (options.verbose) {
        process.env.OM_VERBOSE = "true";
    }

    console.log("🧹 OpenMemory Test Artifacts Cleanup");
    console.log("=====================================");
    
    if (options.dryRun) {
        console.log("🔍 DRY RUN MODE - No files will be deleted");
    }

    console.log(`📁 Working directory: ${process.cwd()}`);
    console.log(`🗃️  Databases: ${options.databases ? '✅' : '❌'}`);
    console.log(`📄 Logs: ${options.logs ? '✅' : '❌'}`);
    console.log(`📦 Node modules: ${options.nodeModules ? '✅' : '❌'}`);
    console.log("");

    try {
        const startTime = Date.now();
        
        const result = await cleanupTestArtifacts({
            databases: options.databases,
            logs: options.logs,
            nodeModules: options.nodeModules,
            dryRun: options.dryRun
        });

        const duration = Date.now() - startTime;

        console.log("📊 Cleanup Results:");
        console.log(`   ✅ Files processed: ${result.deleted + result.failed}`);
        console.log(`   🗑️  Files deleted: ${result.deleted}`);
        console.log(`   ❌ Failed deletions: ${result.failed}`);
        console.log(`   ⏱️  Duration: ${duration}ms`);

        if (options.verbose && result.files.length > 0) {
            console.log("\n📋 Processed files:");
            for (const file of result.files) {
                console.log(`   • ${file}`);
            }
        }

        if (result.failed > 0) {
            console.warn(`\n⚠️  ${result.failed} files could not be deleted. Check permissions or if files are in use.`);
            process.exit(1);
        }

        if (result.deleted === 0) {
            console.log("\n✨ No test artifacts found - workspace is clean!");
        } else {
            console.log(`\n✨ Successfully cleaned up ${result.deleted} test artifacts!`);
        }

    } catch (error) {
        console.error("❌ Cleanup failed:", error);
        process.exit(1);
    }
}

// Run the script
if (import.meta.main) {
    main().catch((error) => {
        console.error("💥 Script failed:", error);
        process.exit(1);
    });
}
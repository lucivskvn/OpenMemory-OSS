/**
 * @file Test Cleanup Utilities
 * Provides automated cleanup of test artifacts including database files, logs, and temporary files.
 * Uses Bun Native APIs for cross-platform file operations.
 */

import { logger } from "./logger";

export interface CleanupOptions {
    /** Whether to clean up database files (*.db, *.sqlite, *-shm, *-wal) */
    databases?: boolean;
    /** Whether to clean up log files (*.log, *.txt) */
    logs?: boolean;
    /** Whether to clean up node_modules test artifacts */
    nodeModules?: boolean;
    /** Custom patterns to clean up */
    customPatterns?: string[];
    /** Dry run - log what would be deleted without actually deleting */
    dryRun?: boolean;
}

/**
 * Patterns for different types of test artifacts
 */
const CLEANUP_PATTERNS = {
    databases: [
        "test_*.db",
        "test_*.sqlite",
        "*.test_*.db",
        "*.test_*.sqlite",
        "*test_*.db-shm",
        "*test_*.db-wal",
        "*test_*.sqlite-shm", 
        "*test_*.sqlite-wal",
        ".test_*.db",
        ".test_*.sqlite",
        ".test_*-shm",
        ".test_*-wal"
    ],
    logs: [
        "test_output.log",
        "test_output.txt",
        "final_test_output.txt",
        "omnibus_debug.txt",
        "tsc_final.txt"
    ],
    nodeModules: [
        "apps/*/node_modules/openmemory-js/test_output.*",
        "packages/*/node_modules/openmemory-js/test_output.*"
    ]
};

/**
 * Cross-platform file deletion using Bun.spawn
 */
async function deleteFile(filePath: string, dryRun = false): Promise<boolean> {
    try {
        const exists = await Bun.file(filePath).exists();
        if (!exists) return false;

        if (dryRun) {
            logger.info(`[CLEANUP] Would delete: ${filePath}`);
            return true;
        }

        // Use cross-platform deletion
        const platform = process.platform;
        if (platform === 'win32') {
            // Use PowerShell Remove-Item for Windows
            await Bun.spawn(['powershell', '-Command', `Remove-Item -Path "${filePath}" -Force -ErrorAction SilentlyContinue`], {
                stderr: 'ignore',
                stdout: 'ignore'
            });
        } else {
            await Bun.spawn(['rm', '-f', filePath], {
                stderr: 'ignore', 
                stdout: 'ignore'
            });
        }

        logger.debug(`[CLEANUP] Deleted: ${filePath}`);
        return true;
    } catch (error) {
        logger.warn(`[CLEANUP] Failed to delete ${filePath}:`, error);
        return false;
    }
}

/**
 * Find files matching glob patterns using Bun.Glob
 */
async function findFiles(patterns: string[], baseDir = process.cwd()): Promise<string[]> {
    const files: string[] = [];
    
    for (const pattern of patterns) {
        try {
            const glob = new Bun.Glob(pattern);
            for await (const file of glob.scan({ cwd: baseDir })) {
                files.push(file);
            }
        } catch (error) {
            logger.warn(`[CLEANUP] Failed to scan pattern ${pattern}:`, error);
        }
    }
    
    return [...new Set(files)]; // Remove duplicates
}

/**
 * Clean up test artifacts based on the provided options
 */
export async function cleanupTestArtifacts(options: CleanupOptions = {}): Promise<{
    deleted: number;
    failed: number;
    files: string[];
}> {
    const {
        databases = true,
        logs = true,
        nodeModules = false,
        customPatterns = [],
        dryRun = false
    } = options;

    let patterns: string[] = [];
    
    if (databases) patterns.push(...CLEANUP_PATTERNS.databases);
    if (logs) patterns.push(...CLEANUP_PATTERNS.logs);
    if (nodeModules) patterns.push(...CLEANUP_PATTERNS.nodeModules);
    if (customPatterns.length > 0) patterns.push(...customPatterns);

    if (patterns.length === 0) {
        logger.info("[CLEANUP] No cleanup patterns specified");
        return { deleted: 0, failed: 0, files: [] };
    }

    logger.info(`[CLEANUP] Starting cleanup with ${patterns.length} patterns${dryRun ? ' (DRY RUN)' : ''}`);

    const files = await findFiles(patterns);
    logger.info(`[CLEANUP] Found ${files.length} files to clean up`);

    let deleted = 0;
    let failed = 0;
    const processedFiles: string[] = [];

    for (const file of files) {
        const success = await deleteFile(file, dryRun);
        if (success) {
            deleted++;
            processedFiles.push(file);
        } else {
            failed++;
        }
    }

    logger.info(`[CLEANUP] Completed: ${deleted} deleted, ${failed} failed`);
    return { deleted, failed, files: processedFiles };
}

/**
 * Pre-test cleanup - removes stale artifacts before test execution
 */
export async function preTestCleanup(): Promise<void> {
    logger.info("[CLEANUP] Running pre-test cleanup...");
    
    const result = await cleanupTestArtifacts({
        databases: true,
        logs: true,
        nodeModules: false, // Don't clean node_modules during pre-test
        dryRun: false
    });

    if (result.deleted > 0) {
        logger.info(`[CLEANUP] Pre-test cleanup removed ${result.deleted} stale artifacts`);
    }
}

/**
 * Post-test cleanup - removes artifacts after test execution
 */
export async function postTestCleanup(): Promise<void> {
    logger.info("[CLEANUP] Running post-test cleanup...");
    
    const result = await cleanupTestArtifacts({
        databases: true,
        logs: true,
        nodeModules: true, // Clean node_modules after tests
        dryRun: false
    });

    if (result.deleted > 0) {
        logger.info(`[CLEANUP] Post-test cleanup removed ${result.deleted} artifacts`);
    }
}

/**
 * Clean up specific test database files by pattern
 */
export async function cleanupTestDatabases(pattern?: string): Promise<number> {
    const patterns = pattern ? [pattern] : CLEANUP_PATTERNS.databases;
    
    const result = await cleanupTestArtifacts({
        databases: true,
        logs: false,
        nodeModules: false,
        customPatterns: pattern ? [pattern] : [],
        dryRun: false
    });

    return result.deleted;
}

/**
 * Emergency cleanup - removes all test artifacts immediately
 */
export async function emergencyCleanup(): Promise<void> {
    logger.warn("[CLEANUP] Running emergency cleanup of all test artifacts...");
    
    await cleanupTestArtifacts({
        databases: true,
        logs: true,
        nodeModules: true,
        dryRun: false
    });
}

/**
 * Cleanup hook for process exit
 */
export function setupCleanupOnExit(): void {
    const cleanup = async () => {
        try {
            await postTestCleanup();
        } catch (error) {
            logger.error("[CLEANUP] Exit cleanup failed:", error);
        }
    };

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', cleanup);
}

/**
 * Utility to clean up a specific test's artifacts
 */
export async function cleanupTestFiles(testName: string): Promise<void> {
    const patterns = [
        `*${testName}*.db`,
        `*${testName}*.sqlite`,
        `*${testName}*.db-shm`,
        `*${testName}*.db-wal`,
        `*${testName}*.sqlite-shm`,
        `*${testName}*.sqlite-wal`,
        `test_${testName}_*.db`,
        `test_${testName}_*.sqlite`
    ];

    await cleanupTestArtifacts({
        databases: false,
        logs: false,
        nodeModules: false,
        customPatterns: patterns,
        dryRun: false
    });
}
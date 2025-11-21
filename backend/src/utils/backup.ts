import { existsSync, unlinkSync, readdirSync, statSync, mkdirSync, createWriteStream } from "fs";
import { join, dirname } from "path";
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { env } from "../core/cfg.js";
import logger from "../core/logger.js";
import { createSQLiteDatabase } from "../core/sqlite-runtime.js";
import { pipeline } from "stream/promises";

export interface BackupOptions {
    sourcePath: string;
    destPath: string;
    progressCallback?: (progress: { percentage: number; remainingPages: number; totalPages: number }) => void;
}

export interface RestoreOptions {
    backupPath: string;
    targetPath: string;
    verify?: boolean;
}

// Helper: Check if a file is a SQL dump (by extension or content)
function isSqlDump(filePath: string): boolean {
    if (filePath.endsWith('.sql')) {
        return true;
    }
    // Could add more sophisticated detection here
    return false;
}

// Helper: Ensure directory exists
function ensureDirectoryExists(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

export async function backupDatabase(options: BackupOptions): Promise<void> {
    const { sourcePath, destPath, progressCallback } = options;

    ensureDirectoryExists(destPath);

    // Check if we can use node:sqlite backup API
    let useNodeBackup = false;
    let DatabaseSync: any = null;
    try {
        const nodeSqlite = await import('node:sqlite');
        DatabaseSync = nodeSqlite.DatabaseSync;
        useNodeBackup = !!DatabaseSync;
    } catch {
        // Not available
    }

    if (useNodeBackup) {
        // Use node:sqlite backup API for zero-downtime copies
        const sourceDb = new DatabaseSync(sourcePath);
        try {
            // Flush WAL to ensure consistent snapshot
            sourceDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");

            const backup = sourceDb.backup(destPath);
            try {
                while (backup.remaining > 0) {
                    backup.step(1); // Step one page at a time for progress
                    if (progressCallback) {
                        const totalPages = backup.pageCount;
                        const remainingPages = backup.remaining;
                        const percentage = ((totalPages - remainingPages) / totalPages) * 100;
                        progressCallback({ percentage, remainingPages, totalPages });
                    }
                }
            } finally {
                backup.finish();
            }
        } finally {
            sourceDb.close();
        }
    } else {
        // Fallback to cross-runtime VACUUM INTO for Bun or other runtimes
        const sourceDb = await createSQLiteDatabase(sourcePath);
        try {
            const escapedPath = destPath.replace(/'/g, "''");
            await sourceDb.run(`VACUUM INTO '${escapedPath}'`);
            if (progressCallback) {
                progressCallback({ percentage: 100, remainingPages: 0, totalPages: 1 });
            }
        } finally {
            sourceDb.close();
        }
    }
}

export async function exportDatabaseDump(sourceDbPath: string, dumpPath: string): Promise<void> {
    ensureDirectoryExists(dumpPath);

    const db = await createSQLiteDatabase(sourceDbPath);

    try {
        // Get all tables, indexes, views, etc.
        const schemaRows = await db.all(`
            SELECT sql FROM sqlite_master
            WHERE sql IS NOT NULL AND type IN ('table', 'index', 'view', 'trigger')
            ORDER BY CASE
                WHEN type = 'table' THEN 1
                WHEN type = 'index' THEN 2
                WHEN type = 'view' THEN 3
                WHEN type = 'trigger' THEN 4
                ELSE 5
            END
        `) as { sql: string }[];

        let dump = 'PRAGMA foreign_keys=OFF;\n';
        dump += 'BEGIN TRANSACTION;\n\n';

        // Add schema
        for (const row of schemaRows) {
            dump += row.sql + ';\n\n';
        }

        // Add data for each table
        const tables = await db.all(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `) as { name: string }[];

        for (const table of tables) {
            const rows = await db.all(`SELECT * FROM ${table.name}`);
            if (rows.length > 0) {
                const columns = Object.keys(rows[0]);
                const placeholders = columns.map(() => '?').join(', ');

                for (const row of rows) {
                    const values = columns.map(col => {
                        const val = row[col];
                        if (val === null) return 'NULL';
                        if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
                        return val;
                    });
                    dump += `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
                }
            }
            dump += '\n';
        }

        dump += 'COMMIT;\n';

        await Bun.file(dumpPath).write(dump);

    } finally {
        db.close();
    }
}

export async function importDatabaseDump(dumpPath: string, targetDbPath: string): Promise<void> {
    // For clean restore: ensure we start with a fresh database file
    if (existsSync(targetDbPath)) {
        unlinkSync(targetDbPath);
    }

    ensureDirectoryExists(targetDbPath);

    const db = await createSQLiteDatabase(targetDbPath);

    try {
        // Alternative clean restore approach: drop all existing objects
        // (keeping as backup in case file deletion isn't preferred)
        /*
        const existingObjects = await db.all(`
            SELECT type, name FROM sqlite_master
            WHERE type IN ('table', 'index', 'view', 'trigger')
            AND name NOT LIKE 'sqlite_%'
        `) as { type: string; name: string }[];

        for (const obj of existingObjects) {
            try {
                await db.run(`DROP ${obj.type.toUpperCase()} IF EXISTS ${obj.name}`);
            } catch (e) {
                // Ignore errors for missing objects
            }
        }
        */

        const dump = await Bun.file(dumpPath).text();

        // Execute the dump
        await db.run(dump);

        // Verify integrity
        const integrity = await db.get("PRAGMA integrity_check") as { integrity_check: string };
        if (integrity.integrity_check !== 'ok') {
            throw new Error('Database integrity check failed after import');
        }

    } finally {
        db.close();
    }
}

export async function restoreFromBackup(options: RestoreOptions): Promise<void> {
    const { backupPath, targetPath, verify = false } = options;

    if (!existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
    }

    if (isSqlDump(backupPath)) {
        // For SQL dumps: ensure clean restore by starting fresh
        await importDatabaseDump(backupPath, targetPath);

        if (verify) {
            const db = await createSQLiteDatabase(targetPath);
            try {
                const integrity = await db.get("PRAGMA integrity_check") as { integrity_check: string };
                if (integrity.integrity_check !== 'ok') {
                    throw new Error('Database integrity check failed after restore');
                }
            } finally {
                db.close();
            }
        }
    } else {
        // For binary backups: copy and verify
        await backupDatabase({
            sourcePath: backupPath,
            destPath: targetPath
        });

        if (verify) {
            const db = await createSQLiteDatabase(targetPath);
            try {
                const integrity = await db.get("PRAGMA integrity_check") as { integrity_check: string };
                if (integrity.integrity_check !== 'ok') {
                    throw new Error('Database integrity check failed after restore');
                }
            } finally {
                db.close();
            }
        }
    }
}

export async function listBackups(backupDir: string, includeCloud: boolean = false, s3Client?: any): Promise<BackupMetadata[]> {
    const backups: BackupMetadata[] = [];

    // Local backups
    if (existsSync(backupDir)) {
        const files = readdirSync(backupDir);

        for (const file of files) {
            if (file.endsWith('.db') || file.endsWith('.sql')) {
                const filePath = join(backupDir, file);
                const stats = statSync(filePath);

                backups.push({
                    filename: file,
                    size: stats.size,
                    createdAt: stats.birthtime.toISOString(),
                    location: 'local' as const
                });
            }
        }
    }

    // Cloud backups
    if (includeCloud && s3Client) {
        try {
            const command = new ListObjectsV2Command({
                Bucket: env.bucket_name,
                Prefix: 'backups/',
            });

            const response = await s3Client.send(command);
            if (response.Contents) {
                for (const obj of response.Contents) {
                    if (obj.Key && obj.Key.endsWith('.db')) {
                        const filename = obj.Key.replace('backups/', '');
                        backups.push({
                            filename,
                            size: obj.Size || 0,
                            createdAt: obj.LastModified?.toISOString() || new Date().toISOString(),
                            location: 'cloud' as const
                        });
                    }
                }
            }
        } catch (error) {
            logger.warn({ error }, 'Failed to list cloud backups');
        }
    }

    // Sort by creation date, newest first
    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return backups;
}

export async function vacuumIntoBackup(sourceDbPath: string, destPath: string): Promise<void> {
    ensureDirectoryExists(destPath);

    const db = await createSQLiteDatabase(sourceDbPath);
    try {
        // VACUUM INTO creates a compacted copy
        const escapedPath = destPath.replace(/'/g, "''");
        await db.run(`VACUUM INTO '${escapedPath}'`);
    } finally {
        db.close();
    }
}

export async function uploadToSupabaseStorage(localPath: string, objectKey: string, s3Client?: any): Promise<void> {
    if (!s3Client) {
        throw new Error('s3Client is required for upload');
    }
    const file = Bun.file(localPath);
    const command = new PutObjectCommand({
        Bucket: env.bucket_name,
        Key: `backups/${objectKey}`,
        Body: await file.stream(),
    });
    await s3Client.send(command);
}

export async function downloadFromSupabaseStorage(objectKey: string, destPath: string, s3Client?: any): Promise<void> {
    if (!s3Client) {
        throw new Error('s3Client is required for download');
    }
    const command = new GetObjectCommand({
        Bucket: env.bucket_name,
        Key: `backups/${objectKey}`,
    });
    const response = await s3Client.send(command);
    if (!response.Body) {
        throw new Error('No body in S3 response');
    }
    await pipeline(response.Body as any, createWriteStream(destPath));
}

// Define missing types that might be expected
export interface BackupMetadata {
    filename: string;
    size: number;
    createdAt: string;
    location: 'local' | 'cloud';
}

export async function enforceBackupRetention(backupDir: string): Promise<void> {
    const retentionDays = env.backup_retention_days;
    const now = Date.now();
    const cutoffMs = retentionDays * 24 * 60 * 60 * 1000; // days to milliseconds

    const backups = await listBackups(backupDir);
    const toDelete = backups.filter(backup => now - new Date(backup.createdAt).getTime() > cutoffMs);

    for (const backup of toDelete) {
        try {
            unlinkSync(join(backupDir, backup.filename));
            logger.info({ filename: backup.filename, age: retentionDays }, 'Deleted old backup due to age retention policy');
        } catch (e) {
            logger.warn({ filename: backup.filename }, 'Failed to delete old backup');
        }
    }
}

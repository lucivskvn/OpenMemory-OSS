import { Context } from "../server";
import { env, getS3Client } from "../../core/cfg.js";
import { backupDatabase, listBackups, restoreFromBackup, uploadToSupabaseStorage, downloadFromSupabaseStorage, enforceBackupRetention } from "../../utils/backup.js";
import { adminAuthMiddleware } from "../middleware/auth.js";
import { z } from "zod";
import { stat, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { exec } from "child_process";
import { promisify } from "util";

async function ensureDirectoryExists(filePath: string): Promise<void> {
    const dir = join(filePath, '..');
    try {
        await mkdir(dir, { recursive: true });
    } catch (error) {
        // Directory might already exist, ignore error
    }
}

// In-memory store for progress tracking
const progressStore = new Map<string, { percentage: number; message: string; startTime: number }>();

// Cache for disk space info (1 minute TTL)
let diskSpaceCache: { available: number; total: number; timestamp: number } | null = null;
const DISK_SPACE_CACHE_TTL = 60000; // 1 minute

async function getDiskSpace(backupDir: string): Promise<{ available: number; total: number; } | null> {
    // Check cache first
    const now = Date.now();
    if (diskSpaceCache && (now - diskSpaceCache.timestamp) < DISK_SPACE_CACHE_TTL) {
        return { available: diskSpaceCache.available, total: diskSpaceCache.total };
    }

    try {
        const isWin32 = process.platform === 'win32';
        let available = 0;
        let total = 0;

        if (isWin32) {
            // Windows fallback - try wmic command
            try {
                const execAsync = promisify(exec);
                const { stdout } = await execAsync('wmic logicaldisk get size,freespace,caption');
                // Parse Windows output (this is simplified - would need more robust parsing in production)
                // For now, return null as the Windows implementation is basic
                return null;
            } catch {
                // Windows command failed, return null
                return null;
            }
        } else {
            // Unix-like systems: use df -k
            try {
                const execAsync = promisify(exec);
                const { stdout } = await execAsync(`df -k "${backupDir}"`);
                const lines = stdout.trim().split('\n');

                if (lines.length >= 2) {
                    const infoLine = lines[1];
                    const parts = infoLine.trim().split(/\s+/);

                    // df -k output format: Filesystem 1024-blocks Used Available Use% Mounted-on
                    if (parts.length >= 4) {
                        total = parseInt(parts[1], 10) * 1024; // Convert KB to bytes
                        available = parseInt(parts[3], 10) * 1024; // Convert KB to bytes
                    }
                }
            } catch {
                // df command failed, return null
                return null;
            }
        }

        // Cache the result
        diskSpaceCache = { available, total, timestamp: now };
        return { available, total };

    } catch (error) {
        // Any other error, return null
        return null;
    }
}

type BackupResponse = {
    success: boolean;
    filename: string;
    path: string;
    location: "local" | "cloud";
    timestamp: string;
    sessionId?: string;
};

type BackupStatus = {
    lastBackup: string | null;
    backupCount: number;
    databaseSize: number;
    walSize: number;
    diskSpace: {
        available: number;
        total: number;
    } | null;
    cloudEnabled: boolean;
    autoSchedule: boolean;
    scheduleCron: string;
    retentionDays: number;
};

export function backup(app: any): void {
    /**
     * POST /admin/backup
     * Trigger a database backup with optional cloud upload
     */
    app.post('/admin/backup', adminAuthMiddleware, async (req: Request, ctx: any) => {
        try {
            // Parse body
            let body: any = (ctx && ctx.body) ? ctx.body : undefined;
            if (!body) {
                try {
                    body = await req.clone().json();
                } catch (e) {
                    body = {};
                }
            }
            const { cloud = false } = body || {};

            // Generate session ID for progress tracking
            const sessionId = `backup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            // Initialize progress
            progressStore.set(sessionId, { percentage: 0, message: "Starting backup...", startTime: Date.now() });

            // Generate backup filename
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `backup-${timestamp}.db`;
            const localPath = join(env.backup_dir, filename);

            // Progress callback for backupDatabase
            const progressCallback = (progress: { percentage: number; remainingPages: number; totalPages: number }) => {
                progressStore.set(sessionId, {
                    percentage: progress.percentage,
                    message: `Backing up... ${progress.remainingPages} pages remaining`,
                    startTime: Date.now()
                });
            };

            // Perform backup
            await backupDatabase({
                sourcePath: env.db_path,
                destPath: localPath,
                progressCallback
            });

            // Apply retention policy
            await enforceBackupRetention(env.backup_dir);

            // Update progress
            progressStore.set(sessionId, { percentage: 100, message: "Local backup completed", startTime: Date.now() });

            let location: "local" | "cloud" = "local";

            // Optional cloud upload
            if (cloud && env.backup_cloud_enabled) {
                progressStore.set(sessionId, { percentage: 100, message: "Uploading to cloud...", startTime: Date.now() });
                try {
                    await uploadToSupabaseStorage(localPath, filename, getS3Client());
                    location = "cloud";
                    progressStore.set(sessionId, { percentage: 100, message: "Cloud upload completed", startTime: Date.now() });
                } catch (err) {
                    // Cloud upload failed, but local backup is still valid
                    console.warn("Cloud upload failed:", err);
                }
            }

            // Cleanup progress after completion
            setTimeout(() => progressStore.delete(sessionId), 300000); // 5 minutes

            const response: BackupResponse = {
                success: true,
                filename,
                path: localPath,
                location,
                timestamp: new Date().toISOString(),
                sessionId
            };

            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (error) {
            return new Response(JSON.stringify({
                success: false,
                error: String(error)
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    /**
     * POST /admin/backup/config
     * Update backup configuration (scheduling and retention)
     */
    app.post('/admin/backup/config', adminAuthMiddleware, async (req: Request) => {
        try {
            // Parse body
            let body: any;
            try {
                body = await req.json();
            } catch (e) {
                body = {};
            }

            const schema = z.object({
                autoSchedule: z.boolean(),
                scheduleCron: z.string().min(1),
                retentionDays: z.number().int().min(1).max(30)
            });

            const validation = schema.safeParse(body);
            if (!validation.success) {
                return new Response(JSON.stringify({
                    error: 'Invalid request body',
                    details: validation.error.issues
                }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const { autoSchedule, scheduleCron, retentionDays } = validation.data;

            // Persist to a simple JSON file in data directory
            const configPath = join(process.cwd(), 'data', 'backup-config.json');
            ensureDirectoryExists(configPath);

            const config = {
                autoSchedule,
                scheduleCron,
                retentionDays,
                updatedAt: new Date().toISOString()
            };

            writeFileSync(configPath, JSON.stringify(config, null, 2));

            return new Response(JSON.stringify({
                success: true,
                message: 'Configuration saved successfully',
                config
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (error) {
            return new Response(JSON.stringify({
                error: 'Configuration save failed',
                message: String(error)
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    /**
     * GET /admin/backup/list
     * List available backups
     */
    app.get('/admin/backup/list', adminAuthMiddleware, async () => {
        try {
            const backups = await listBackups(env.backup_dir, env.backup_cloud_enabled || false, getS3Client());

            return new Response(JSON.stringify({ backups }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            return new Response(JSON.stringify({ error: 'Failed to list backups', message: String(error) }), {
                status: 500, headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    /**
     * GET /admin/backup/status
     * Get backup status and system information
     */
    app.get('/admin/backup/status', adminAuthMiddleware, async () => {
        try {
            const backups = await listBackups(env.backup_dir);
            const lastBackup = backups.length > 0 ? backups[0].createdAt : null;
            const backupCount = backups.length;

            // Get database size
            let databaseSize = 0;
            let walSize = 0;

            try {
                if (existsSync(env.db_path)) {
                    const stats = await stat(env.db_path);
                    databaseSize = stats.size;
                }

                const walPath = `${env.db_path}-wal`;
                if (existsSync(walPath)) {
                    const stats = await stat(walPath);
                    walSize = stats.size;
                }
            } catch (err) {
                // Ignore stat errors
            }

            // Get disk space using system commands
            let diskSpace = await getDiskSpace(env.backup_dir);

            // Load schedule config from file
            let scheduleCron = "0 2 * * *";
            let retentionDays = 7;
            try {
                const configPath = join(process.cwd(), 'data', 'backup-config.json');
                if (existsSync(configPath)) {
                    const configData = require(configPath);
                    scheduleCron = configData.scheduleCron || scheduleCron;
                    retentionDays = configData.retentionDays || retentionDays;
                }
            } catch {
                // Ignore config errors, use defaults
            }

            const status: BackupStatus = {
                lastBackup,
                backupCount,
                databaseSize,
                walSize,
                diskSpace,
                cloudEnabled: env.backup_cloud_enabled || false,
                autoSchedule: env.backup_auto_schedule || false,
                scheduleCron,
                retentionDays
            };

            return new Response(JSON.stringify(status), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            return new Response(JSON.stringify({ error: 'Failed to get backup status', message: String(error) }), {
                status: 500, headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    /**
     * POST /admin/backup/restore
     * Restore database from backup
     */
    app.post('/admin/backup/restore', adminAuthMiddleware, async (req: Request, ctx: any) => {
        try {
            // Parse body
            let body: any = (ctx && ctx.body) ? ctx.body : undefined;
            if (!body) {
                try {
                    body = await req.clone().json();
                } catch (e) {
                    body = {};
                }
            }

            const schema = z.object({
                filename: z.string().min(1),
                location: z.enum(["local", "cloud"])
            });

            const validation = schema.safeParse(body);
            if (!validation.success) {
                return new Response(JSON.stringify({
                    error: 'Invalid request body',
                    details: validation.error.issues
                }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const { filename, location } = validation.data;

            if (location === "cloud") {
                // Cloud restore: download to temp, restore, cleanup
                const tempPath = join(tmpdir(), `restore-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.db`);

                try {
                    // Download from cloud storage
                    await downloadFromSupabaseStorage(filename, tempPath, getS3Client());

                    // Restore from temp file
                    await restoreFromBackup({
                        backupPath: tempPath,
                        targetPath: env.db_path,
                        verify: true
                    });

                    // Cleanup temp file
                    await unlink(tempPath);

                    return new Response(JSON.stringify({
                        success: true,
                        message: 'Database restored successfully from cloud backup',
                        integrityChecked: true
                    }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });

                } catch (error) {
                    // Cleanup temp file on error
                    try {
                        await unlink(tempPath);
                    } catch (cleanupError) {
                        // Ignore cleanup errors
                    }
                    throw error; // Re-throw to be handled below
                }
            }

            // Local restore
            const backupPath = join(env.backup_dir, filename);
            if (!existsSync(backupPath)) {
                return new Response(JSON.stringify({
                    error: 'Backup file not found',
                    filename
                }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            await restoreFromBackup({
                backupPath,
                targetPath: env.db_path,
                verify: true
            });

            return new Response(JSON.stringify({
                success: true,
                message: 'Database restored successfully',
                integrityChecked: true
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (error) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Restore failed',
                message: String(error)
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });

    /**
     * GET /admin/backup/progress/:sessionId
     * Get backup progress for a session
     */
    app.get('/admin/backup/progress/:sessionId', adminAuthMiddleware, async (req: Request) => {
        try {
            const url = new URL(req.url);
            const sessionId = url.pathname.split('/').pop();

            if (!sessionId || !progressStore.has(sessionId)) {
                return new Response(JSON.stringify({
                    error: 'Session not found'
                }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const progress = progressStore.get(sessionId)!;

            return new Response(JSON.stringify({
                percentage: progress.percentage,
                message: progress.message,
                sessionId
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (error) {
            return new Response(JSON.stringify({
                error: 'Failed to get progress',
                message: String(error)
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    });
}

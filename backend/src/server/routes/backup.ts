import { env, getS3Client } from "../../core/cfg";
import { getRawDb } from "../../core/db";
import logger from "../../core/logger";
import { backupDatabase, restoreFromBackup, uploadToSupabaseStorage, downloadFromSupabaseStorage } from "../../utils/backup";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";

export function backup(app: any) {
    app.post("/admin/backup/create", async (req: any, res: any) => {
        if (env.metadata_backend === "postgres") {
             return res.status(400).json({ success: false, error: "Backup API only supports SQLite" });
        }

        try {
            const db = getRawDb();
            if (!db) {
                throw new Error("Database not initialized or not SQLite");
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const filename = `backup-${timestamp}.db`;
            const backupDir = path.join(path.dirname(env.db_path), "backups");

            // Ensure backup dir exists
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            const backupPath = path.join(backupDir, filename);

            await backupDatabase(db, backupPath);

            if (env.backup_cloud_enabled && env.bucket_name) {
                try {
                    const s3 = getS3Client();
                    await uploadToSupabaseStorage(backupPath, filename, s3);
                } catch (cloudErr) {
                    logger.error({ component: "BACKUP", err: cloudErr }, "Cloud upload failed");
                    // We continue to return success but could include a warning
                }
            }

            res.json({ success: true, filename });
        } catch (err) {
            logger.error({ component: "BACKUP", err }, "Backup creation failed");
            res.status(500).json({ success: false, error: String(err) });
        }
    });

    app.get("/admin/backup/status", async (req: any, res: any) => {
        try {
            // List local backups
            const backupDir = path.join(path.dirname(env.db_path), "backups");
            let backups: any[] = [];
            if (fs.existsSync(backupDir)) {
                const files = fs.readdirSync(backupDir).filter(f => f.endsWith(".db"));
                backups = files.map(f => {
                    const stat = fs.statSync(path.join(backupDir, f));
                    return {
                        filename: f,
                        size: stat.size,
                        createdAt: stat.birthtime,
                    };
                });
                // Sort desc
                backups.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            }

            // Schedule info
            const schedulePath = path.join(path.dirname(env.db_path), "backup_schedule.json");
            let schedule = {
                enabled: false,
                frequency: "daily",
                retention: 7,
            };

            if (fs.existsSync(schedulePath)) {
                try {
                    const loaded = JSON.parse(fs.readFileSync(schedulePath, "utf-8"));
                    schedule = { ...schedule, ...loaded };
                } catch (e) {
                    logger.warn({ component: "BACKUP", err: e }, "Failed to load schedule config");
                }
            }

            res.json({
                backups,
                diskSpace: null,
                schedule,
            });
        } catch (err) {
            logger.error({ component: "BACKUP", err }, "Failed to get status");
            res.status(500).json({ success: false, error: String(err) });
        }
    });

    app.post("/admin/backup/restore", async (req: any, res: any) => {
        if (env.metadata_backend === "postgres") {
             return res.status(400).json({ success: false, error: "Restore API only supports SQLite" });
        }

        try {
            const schema = z.object({
                filename: z.string(),
                source: z.enum(["local", "cloud"]).default("local"),
            });
            const { filename, source } = schema.parse(req.body);

            let sourcePath = "";
            let tempDir = "";

            if (source === "cloud") {
                if (!env.backup_cloud_enabled) {
                    throw new Error("Cloud backup is not enabled");
                }
                tempDir = fs.mkdtempSync(path.join(path.dirname(env.db_path), "restore-"));
                sourcePath = path.join(tempDir, filename);
                const s3 = getS3Client();
                await downloadFromSupabaseStorage(filename, sourcePath, s3);
            } else {
                sourcePath = path.join(path.dirname(env.db_path), "backups", filename);
                if (!fs.existsSync(sourcePath)) {
                    throw new Error("Backup file not found locally");
                }
            }

            // Verify and restore
            await restoreFromBackup({
                backupPath: sourcePath,
                targetPath: env.db_path,
                verify: true
            });

            if (tempDir) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }

            res.json({ success: true });
        } catch (err) {
            logger.error({ component: "BACKUP", err }, "Restore failed");
            res.status(500).json({ success: false, error: String(err) });
        }
    });

    app.post("/admin/backup/config", async (req: any, res: any) => {
        try {
             const schema = z.object({
                scheduleEnabled: z.boolean(),
                scheduleFreq: z.string(),
                retentionDays: z.number(),
             });
             const body = schema.parse(req.body);

             const schedulePath = path.join(path.dirname(env.db_path), "backup_schedule.json");
             const configToSave = {
                 enabled: body.scheduleEnabled,
                 frequency: body.scheduleFreq,
                 retention: body.retentionDays,
             };

             // Ensure directory exists
             const dir = path.dirname(schedulePath);
             if (!fs.existsSync(dir)) {
                 fs.mkdirSync(dir, { recursive: true });
             }

             fs.writeFileSync(schedulePath, JSON.stringify(configToSave, null, 2));

             logger.info({ component: "BACKUP", config: configToSave }, "Backup schedule updated");
             res.json({ success: true });
        } catch(e) {
            logger.error({ component: "BACKUP", err: e }, "Failed to save config");
            res.status(400).json({error: String(e)});
        }
    });
}

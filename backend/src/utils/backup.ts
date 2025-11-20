import { Database } from "bun:sqlite";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "node:fs";
import path from "node:path";
import { env } from "../core/cfg";
import logger from "../core/logger";

export async function vacuumIntoBackup(db: Database, destPath: string): Promise<void> {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // Escape single quotes in destPath to prevent SQL injection/syntax errors
    // SQLite VACUUM INTO 'filepath' expects a string literal.
    const escapedPath = destPath.replace(/'/g, "''");
    try {
        db.run(`VACUUM INTO '${escapedPath}'`);
    } catch (err) {
        // If VACUUM INTO fails, it might be due to the file already existing
        if (String(err).includes("already exists")) {
             // Delete and retry? Or let it fail?
             // Usually VACUUM INTO requires the file to NOT exist.
             try {
                 if (fs.existsSync(destPath)) {
                     fs.unlinkSync(destPath);
                     db.run(`VACUUM INTO '${escapedPath}'`);
                     return;
                 }
             } catch (e) {
                 // Ignore inner error, throw original
             }
        }
        throw err;
    }
}

export async function uploadToSupabaseStorage(localPath: string, filename: string, s3Client: S3Client) {
    const fileStream = fs.createReadStream(localPath);

    const upload = new Upload({
        client: s3Client,
        params: {
            Bucket: env.bucket_name,
            Key: filename,
            Body: fileStream,
        },
    });

    await upload.done();
    logger.info({ component: "BACKUP", filename }, "Uploaded backup to S3");
}

export async function downloadFromSupabaseStorage(objectKey: string, tempPath: string, s3Client: S3Client) {
    const command = new GetObjectCommand({
        Bucket: env.bucket_name,
        Key: objectKey,
    });

    const response = await s3Client.send(command);

    if (!response.Body) {
        throw new Error("Empty response body from S3");
    }

    // Use transformToByteArray to handle the stream
    const byteArray = await response.Body.transformToByteArray();
    await Bun.write(tempPath, byteArray);
    logger.info({ component: "BACKUP", objectKey, tempPath }, "Downloaded backup from S3");
}

export async function restoreFromBackup(options: { backupPath: string, targetPath: string, verify: boolean }) {
    const { backupPath, targetPath, verify } = options;

    if (verify) {
        logger.info({ component: "BACKUP", backupPath }, "Verifying backup integrity...");
        try {
            const tempDb = new Database(backupPath, { readonly: true });
            const result = tempDb.query("PRAGMA integrity_check").get() as { integrity_check: string };
            tempDb.close();
            // The result key might differ depending on bun:sqlite version or sqlite version.
            // usually it is "integrity_check"
            const status = result ? Object.values(result)[0] : "unknown";
            if (status !== "ok") {
                throw new Error(`Backup integrity check failed: ${status}`);
            }
        } catch (err) {
            logger.error({ component: "BACKUP", err }, "Backup verification failed");
            throw err;
        }
    }

    logger.info({ component: "BACKUP", targetPath }, "Restoring database from backup...");

    if (path.resolve(backupPath) === path.resolve(targetPath)) {
        logger.warn("Skipping restore: source and target are the same file");
        return;
    }

    await fs.promises.copyFile(backupPath, targetPath);
    logger.info({ component: "BACKUP" }, "Restore completed successfully");
}

export async function backupDatabase(db: Database, destPath: string) {
    logger.info({ component: "BACKUP", destPath }, "Starting database backup...");

    // Ensure destination directory exists
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // If file exists, remove it, because VACUUM INTO fails if file exists
    if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
    }

    await vacuumIntoBackup(db, destPath);
    logger.info({ component: "BACKUP" }, "Database backup completed via VACUUM INTO");
}

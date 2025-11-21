#!/usr/bin/env bun
import { backupDatabase } from "../src/utils/backup.js";
import { env } from "../src/core/cfg.js";

// Create a backup with timestamped filename
async function createBackup() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `backup-manual-${timestamp}.db`;
    const backupPath = `${env.backup_dir}/${filename}`;

    console.log(`Creating backup: ${backupPath}`);

    await backupDatabase({
      sourcePath: env.db_path,
      destPath: backupPath,
      progressCallback: (progress) => {
        process.stdout.write(`\rProgress: ${progress.percentage}% (${progress.totalPages - progress.remainingPages}/${progress.totalPages})`);
      }
    });

    console.log(`\n✅ Backup created successfully: ${filename}`);

    // List recent backups
    console.log("\nRecent backups:");
    const { listBackups } = await import("../src/utils/backup.js");
    const backups = await listBackups(env.backup_dir);

    backups.slice(0, 5).forEach(backup => {
      const age = Math.floor((Date.now() - backup.createdAt.getTime()) / (1000 * 60 * 60));
      console.log(`  ${backup.filename} (${age}h ago, ${(backup.size / 1024 / 1024).toFixed(1)}MB)`);
    });

  } catch (error) {
    console.error("❌ Backup failed:", error);
    process.exit(1);
  }
}

createBackup();

#!/usr/bin/env bun
import { listBackups, restoreFromBackup } from "../src/utils/backup.js";
import { env } from "../src/core/cfg.js";

// Restore from the most recent backup with confirmation
async function restoreBackup() {
  try {
    const backups = await listBackups(env.backup_dir);

    if (backups.length === 0) {
      console.log("❌ No backups found in directory:", env.backup_dir);
      process.exit(1);
    }

    const latestBackup = backups[0]; // Already sorted newest first
    const age = Math.floor((Date.now() - latestBackup.createdAt.getTime()) / (1000 * 60 * 60));
    const sizeMB = (latestBackup.size / 1024 / 1024).toFixed(1);

    console.log("🔄 Database Restore");
    console.log("═".repeat(50));
    console.log(`Latest backup: ${latestBackup.filename}`);
    console.log(`Created: ${latestBackup.createdAt.toLocaleString()} (${age}h ago)`);
    console.log(`Size: ${sizeMB} MB`);
    console.log(`Database: ${env.db_path}`);
    console.log("");
    console.log("⚠️  WARNING: This will replace the current database!");
    console.log("   All current data will be lost. Make sure you have a backup.");
    console.log("");

    // Ask for confirmation
    process.stdout.write("Are you sure you want to restore from this backup? (yes/no): ");

    const answer = await new Promise<string>((resolve) => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (data) => {
        resolve(data.toString().trim().toLowerCase());
      });
    });

    if (answer !== 'yes' && answer !== 'y') {
      console.log("❌ Restore cancelled.");
      process.exit(0);
    }

    console.log("🔄 Starting restore...");

    // Determine backup path
    const backupPath = latestBackup.location === 'local'
      ? latestBackup.path
      : latestBackup.path; // In this context, path is already the local path

    await restoreFromBackup({
      backupPath,
      targetPath: env.db_path,
      verify: true
    });

    console.log("✅ Database restored successfully!");
    console.log("");
    console.log("🔄 Next steps:");
    console.log("1. Restart the server to apply changes");
    console.log("2. Verify data integrity through the web interface");
    console.log("3. Test application functionality");

  } catch (error) {
    console.error("❌ Restore failed:", error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

restoreBackup();

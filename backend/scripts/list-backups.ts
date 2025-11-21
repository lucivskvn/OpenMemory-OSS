#!/usr/bin/env bun
import { listBackups } from "../src/utils/backup.js";
import { env } from "../src/core/cfg.js";

// List all available backups
async function listAllBackups() {
  try {
    console.log(`📁 Backups in directory: ${env.backup_dir}`);
    console.log("");

    const backups = await listBackups(env.backup_dir);

    if (backups.length === 0) {
      console.log("No backups found.");
      return;
    }

    console.log("📋 Available backups:");
    console.log("─".repeat(80));

    backups.forEach((backup, index) => {
      const age = Math.floor((Date.now() - backup.createdAt.getTime()) / (1000 * 60 * 60));
      const sizeMB = (backup.size / 1024 / 1024).toFixed(1);
      const created = backup.createdAt.toLocaleString();

      console.log(`${String(index + 1).padStart(2)}. ${backup.filename}`);
      console.log(`    Size: ${sizeMB} MB | Location: ${backup.location} | Created: ${created} (${age}h ago)`);
      console.log("");
    });

    console.log(`Total: ${backups.length} backup(s)`);

    // Show disk usage info
    const { stat } = await import("fs/promises");
    try {
      const stats = await stat(env.backup_dir);
      console.log(`Directory size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
    } catch (error) {
      // Directory might not exist or be empty
    }

  } catch (error) {
    console.error("❌ Failed to list backups:", error);
    process.exit(1);
  }
}

listAllBackups();

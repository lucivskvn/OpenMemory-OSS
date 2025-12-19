#!/usr/bin/env bun
import { init_db } from "./core/db";

async function main() {
    console.log("[MIGRATE] Starting database migration...");
    try {
        await init_db();
        console.log("[MIGRATE] Migration completed successfully.");
        process.exit(0);
    } catch (error) {
        console.error("[MIGRATE] Migration failed:", error);
        process.exit(1);
    }
}

main();

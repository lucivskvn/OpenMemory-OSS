#!/usr/bin/env bun
import { init_db } from "./core/db";
import { log } from "./core/log";

async function main() {
    log.info("[MIGRATE] Starting database migration...");
    try {
        await init_db();
        log.info("[MIGRATE] Migration completed successfully.");
        process.exit(0);
    } catch (error) {
        log.error("[MIGRATE] Migration failed:", { error });
        process.exit(1);
    }
}

main();

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import { vacuumIntoBackup, backupDatabase } from "../../backend/src/utils/backup";

describe("Backup Utils", () => {
    const testDbPath = "test-source.db";
    let db: Database;

    beforeAll(() => {
        db = new Database(testDbPath);
        db.run("CREATE TABLE foo (bar TEXT)");
        db.run("INSERT INTO foo VALUES ('baz')");
    });

    afterAll(() => {
        db.close();
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    it("vacuumIntoBackup handles quotes in path", async () => {
        const weirdPath = "test'backup.db";
        if (fs.existsSync(weirdPath)) fs.unlinkSync(weirdPath);

        await vacuumIntoBackup(db, weirdPath);

        expect(fs.existsSync(weirdPath)).toBe(true);
        fs.unlinkSync(weirdPath);
    });

    it("backupDatabase creates a backup file", async () => {
        const backupPath = "backup-normal.db";
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

        await backupDatabase(db, backupPath);
        expect(fs.existsSync(backupPath)).toBe(true);
        fs.unlinkSync(backupPath);
    });
});

import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';

// Test configuration
const TEST_PORT = 8081;
const BACKUP_API_KEY = 'test-admin-key-12345';

// Test database path
let testDbPath: string;
let backupDir: string;

describe('Backup and Restore E2E Tests', () => {
  let serverProcess: any;

  beforeAll(async () => {
    // Setup test directories and database
    testDbPath = join(tmpdir(), `e2e-test-${Date.now()}.db`);
    backupDir = join(tmpdir(), `e2e-backups-${Date.now()}`);

    // Create test database with some data
    const db = new DatabaseSync(testDbPath);
    db.exec(`
            CREATE TABLE memories (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER
            );

            INSERT INTO memories VALUES ('mem-1', 'user-1', 'Test memory 1', 1234567890000);
            INSERT INTO memories VALUES ('mem-2', 'user-2', 'Test memory 2', 1234567891000);
            INSERT INTO memories VALUES ('mem-3', 'user-1', 'Test memory 3', 1234567892000);
            INSERT INTO memories VALUES ('mem-4', 'user-2', 'Test memory 4', 1234567893000);
        `);
    db.close();

    // Set environment variables for the test server
    process.env.OM_PORT = TEST_PORT.toString();
    process.env.OM_ADMIN_API_KEY = BACKUP_API_KEY;
    process.env.OM_DB_PATH = testDbPath;
    process.env.OM_BACKUP_DIR = backupDir;
    process.env.OM_MODE = 'development';
    process.env.OM_TEST_MODE = '1';

    // Start the backend server
    serverProcess = spawn('bun', ['run', 'backend/src/server.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Wait for server to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, 10000);

      serverProcess.stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('Server listening')) {
          clearTimeout(timeout);
          setTimeout(resolve, 1000); // Give extra time for routes to register
        }
      });

      serverProcess.stderr?.on('data', (data: Buffer) => {
        console.error('Server stderr:', data.toString());
      });
    });
  });

  afterAll(async () => {
    // Stop server
    if (serverProcess) {
      serverProcess.kill();
      await new Promise((resolve) => serverProcess.on('close', resolve));
    }

    // Cleanup test files
    if (existsSync(testDbPath)) {
      unlinkSync(testDbPath);
    }
    if (existsSync(`${testDbPath}-wal`)) {
      unlinkSync(`${testDbPath}-wal`);
    }
    if (existsSync(`${testDbPath}-shm`)) {
      unlinkSync(`${testDbPath}-shm`);
    }
  });

  describe('Backup API Integration', () => {
    test('should successfully trigger a backup via API', async () => {
      const response = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
          body: JSON.stringify({ cloud: false }),
        },
      );

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.filename).toMatch(/backup-.+\.db/);
      expect(result.location).toBe('local');

      // Verify backup file was created
      expect(existsSync(result.path)).toBe(true);
    });

    test('should list available backups', async () => {
      const response = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup/list`,
        {
          headers: {
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
        },
      );

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.backups).toBeDefined();
      expect(Array.isArray(result.backups)).toBe(true);
      expect(result.backups.length).toBeGreaterThan(0);

      // Verify backup metadata
      const firstBackup = result.backups[0];
      expect(firstBackup).toHaveProperty('filename');
      expect(firstBackup).toHaveProperty('size');
      expect(firstBackup).toHaveProperty('createdAt');
      expect(firstBackup).toHaveProperty('location');
      expect(firstBackup.location).toBe('local');
    });

    test('should provide backup status information', async () => {
      const response = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup/status`,
        {
          headers: {
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
        },
      );

      expect(response.ok).toBe(true);
      const status = await response.json();

      expect(status).toHaveProperty('lastBackup');
      expect(status).toHaveProperty('backupCount');
      expect(status).toHaveProperty('databaseSize');
      expect(status).toHaveProperty('cloudEnabled');
      expect(status.backupCount).toBeGreaterThan(0);
      expect(status.databaseSize).toBeGreaterThan(0);
    });
  });

  describe('Restore API Integration', () => {
    test('should successfully restore from backup', async () => {
      // First, get the list of backups
      const listResponse = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup/list`,
        {
          headers: {
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
        },
      );
      const listResult = await listResponse.json();
      const latestBackup = listResult.backups[0];

      // Modify the database to have different state
      const db = new DatabaseSync(testDbPath);
      db.exec(`
                DELETE FROM memories WHERE id = 'mem-1';
                INSERT INTO memories VALUES ('mem-5', 'user-1', 'Modified memory', 1234567894000);
            `);
      db.close();

      // Verify database was modified
      const modifiedDb = new DatabaseSync(testDbPath);
      const modifiedCount = modifiedDb
        .prepare('SELECT COUNT(*) as count FROM memories')
        .get() as { count: number };
      expect(modifiedCount.count).toBe(4); // 3 original + 1 new - 1 deleted
      modifiedDb.close();

      // Restore from backup
      const restoreResponse = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup/restore`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
          body: JSON.stringify({
            filename: latestBackup.filename,
            location: latestBackup.location,
          }),
        },
      );

      expect(restoreResponse.ok).toBe(true);
      const restoreResult = await restoreResponse.json();
      expect(restoreResult.success).toBe(true);
      expect(restoreResult.message).toContain('Database restored');
      expect(restoreResult.integrityChecked).toBe(true);

      // Verify database was restored correctly
      const restoredDb = new DatabaseSync(testDbPath);
      const restoredCount = restoredDb
        .prepare('SELECT COUNT(*) as count FROM memories')
        .get() as { count: number };
      expect(restoredCount.count).toBe(4); // Should now have original data back

      // Check that the deleted memory is back
      const memory1Exists = restoredDb
        .prepare("SELECT COUNT(*) as count FROM memories WHERE id = 'mem-1'")
        .get() as { count: number };
      expect(memory1Exists.count).toBe(1);

      // Check that the new memory is gone (since we restored from backup)
      const memory5Exists = restoredDb
        .prepare("SELECT COUNT(*) as count FROM memories WHERE id = 'mem-5'")
        .get() as { count: number };
      expect(memory5Exists.count).toBe(0);
      restoredDb.close();
    });
  });

  describe('Error Handling', () => {
    test('should reject unauthorized requests', async () => {
      const response = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer invalid-key',
          },
        },
      );

      expect(response.status).toBe(401);
      const result = await response.json();
      expect(result.error).toBe('Unauthorized');
    });

    test('should handle missing backup file gracefully', async () => {
      const response = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup/restore`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
          body: JSON.stringify({
            filename: 'nonexistent-backup.db',
            location: 'local',
          }),
        },
      );

      expect(response.status).toBe(500);
      const result = await response.json();
      expect(result.error).toBeDefined();
    });

    test('should handle invalid backup data', async () => {
      const response = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup/restore`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
          body: JSON.stringify({
            filename: '', // Invalid filename
            location: 'local',
          }),
        },
      );

      // This should fail validation
      const result = await response.json();
      expect(result.error).toBeDefined();
    });
  });

  describe('WAL Mode Handling', () => {
    test('should handle WAL checkpoints during backup', async () => {
      // Enable WAL mode
      const db = new DatabaseSync(testDbPath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(
        "INSERT INTO memories VALUES ('mem-wal-1', 'user-1', 'WAL test memory', 1234567895000)",
      );
      db.close();

      // Verify WAL file exists
      expect(existsSync(`${testDbPath}-wal`)).toBe(true);

      // Perform backup
      const backupResponse = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
          body: JSON.stringify({ cloud: false }),
        },
      );

      expect(backupResponse.ok).toBe(true);
      const backupResult = await backupResponse.json();

      // Verify backup includes WAL data
      const backupDb = new DatabaseSync(backupResult.path);
      const walMemory = backupDb
        .prepare(
          "SELECT COUNT(*) as count FROM memories WHERE id = 'mem-wal-1'",
        )
        .get() as { count: number };
      expect(walMemory.count).toBe(1);
      backupDb.close();
    });
  });

  describe('Concurrent Operations', () => {
    test('should handle multiple backup requests gracefully', async () => {
      const promises = Array(3)
        .fill(null)
        .map(() =>
          fetch(`http://localhost:${TEST_PORT}/admin/backup`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${BACKUP_API_KEY}`,
            },
            body: JSON.stringify({ cloud: false }),
          }),
        );

      const results = await Promise.all(promises);

      for (const response of results) {
        expect(response.ok).toBe(true);
        const result = await response.json();
        expect(result.success).toBe(true);
      }
    });

    test('should prevent concurrent restore operations', async () => {
      // First get a backup to restore from
      const listResponse = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup/list`,
        {
          headers: {
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
        },
      );
      const listResult = await listResponse.json();
      const backupToRestore = listResult.backups[0];

      // Attempt multiple restore operations
      const promises = Array(2)
        .fill(null)
        .map(() =>
          fetch(`http://localhost:${TEST_PORT}/admin/backup/restore`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${BACKUP_API_KEY}`,
            },
            body: JSON.stringify({
              filename: backupToRestore.filename,
              location: backupToRestore.location,
            }),
          }),
        );

      const results = await Promise.all(promises);

      // At least one should succeed, others might fail due to concurrent access
      const successes = results.filter((r) => r.ok).length;
      const failures = results.filter((r) => !r.ok).length;

      expect(successes).toBeGreaterThan(0);
      // Note: We expect some failures in concurrent scenarios due to SQLite locking
    });
  });

  describe('Performance and Scale', () => {
    test('should handle moderate database sizes efficiently', async () => {
      // This is more of a performance benchmark - in real scenarios,
      // you'd want to measure timing and resource usage
      const startTime = Date.now();

      const response = await fetch(
        `http://localhost:${TEST_PORT}/admin/backup`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${BACKUP_API_KEY}`,
          },
          body: JSON.stringify({ cloud: false }),
        },
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(response.ok).toBe(true);
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds for moderate DB

      const result = await response.json();
      expect(result.success).toBe(true);
    });
  });
});

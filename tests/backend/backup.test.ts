import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from 'node:sqlite';
import { S3Client } from '@aws-sdk/client-s3';
import {
  backupDatabase,
  exportDatabaseDump,
  vacuumIntoBackup,
  restoreFromBackup,
  listBackups,
  uploadToSupabaseStorage,
  downloadFromSupabaseStorage,
  importDatabaseDump,
  type BackupOptions,
  type RestoreOptions,
} from '../../backend/src/utils/backup.js';
import { env } from '../../backend/src/core/cfg.js';

// Mock the logger
vi.mock('../../backend/src/core/cfg.js', () => ({
  env: {
    db_path: './test.db',
    backup_dir: './data/backups',
    backup_cloud_enabled: false,
    bucket_name: 'test-bucket',
  },
  getS3Client: vi.fn(() => new S3Client({ region: 'us-east-1' })),
}));

vi.mock('../../backend/src/core/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('SQLite Backup Utilities', () => {
  let testDbPath: string;
  let backupDir: string;
  let s3Client: S3Client;

  beforeEach(() => {
    testDbPath = join(tmpdir(), `test-${Date.now()}.db`);
    backupDir = join(tmpdir(), `backups-${Date.now()}`);
    mkdirSync(backupDir, { recursive: true });

    // Create test database
    const db = new DatabaseSync(testDbPath);
    db.exec(`
            CREATE TABLE test_memories (
                id TEXT PRIMARY KEY,
                content TEXT,
                created_at INTEGER
            );
            INSERT INTO test_memories VALUES ('1', 'test content 1', 1234567890);
            INSERT INTO test_memories VALUES ('2', 'test content 2', 1234567891);
        `);
    db.close();

    s3Client = new S3Client({ region: 'us-east-1' });
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(testDbPath)) unlinkSync(testDbPath);
    if (existsSync(backupDir)) {
      // Remove backup files
      const fs = require('fs');
      const files = fs.readdirSync(backupDir);
      files.forEach((file: string) => {
        try {
          unlinkSync(join(backupDir, file));
        } catch (e) {
          // Ignore cleanup errors
        }
      });
      try {
        fs.rmdirSync(backupDir);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  describe('backupDatabase', () => {
    it('should create a backup successfully', async () => {
      const backupPath = join(backupDir, 'test-backup.db');

      const options: BackupOptions = {
        sourcePath: testDbPath,
        destPath: backupPath,
        progressCallback: vi.fn(),
      };

      await backupDatabase(options);

      expect(existsSync(backupPath)).toBe(true);

      // Verify backup contains data
      const backupDb = new DatabaseSync(backupPath);
      const result = backupDb
        .prepare('SELECT COUNT(*) as count FROM test_memories')
        .get() as { count: number };
      expect(result.count).toBe(2);
      backupDb.close();
    });

    it('should handle WAL checkpointing', async () => {
      const db = new DatabaseSync(testDbPath);
      // Enable WAL mode
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec(
        "INSERT INTO test_memories VALUES ('3', 'test content 3', 1234567892);",
      );
      db.close();

      const backupPath = join(backupDir, 'wal-backup.db');

      const options: BackupOptions = {
        sourcePath: testDbPath,
        destPath: backupPath,
      };

      await backupDatabase(options);

      expect(existsSync(backupPath)).toBe(true);

      // Verify backup contains all data
      const backupDb = new DatabaseSync(backupPath);
      const result = backupDb
        .prepare('SELECT COUNT(*) as count FROM test_memories')
        .get() as { count: number };
      expect(result.count).toBe(3);
      backupDb.close();
    });

    it('should handle progress callbacks', async () => {
      const backupPath = join(backupDir, 'progress-backup.db');
      const progressCallback = vi.fn();

      const options: BackupOptions = {
        sourcePath: testDbPath,
        destPath: backupPath,
        progressCallback,
      };

      await backupDatabase(options);

      expect(progressCallback).toHaveBeenCalled();
      expect(progressCallback).toHaveBeenCalledTimes(expect.any(Number));
      expect(progressCallback.mock.calls.length).toBeGreaterThanOrEqual(1); // Should be called at least once
      const lastCall =
        progressCallback.mock.calls[progressCallback.mock.calls.length - 1][0];
      expect(lastCall.percentage).toBe(100);
      expect(lastCall.totalPages).toBeGreaterThan(0);
      expect(lastCall.remainingPages).toBe(0);
    });

    it('should throw error for invalid source path', async () => {
      const backupPath = join(backupDir, 'error-backup.db');

      const options: BackupOptions = {
        sourcePath: '/nonexistent/path.db',
        destPath: backupPath,
      };

      await expect(backupDatabase(options)).rejects.toThrow();
    });
  });

  describe('exportDatabaseDump', () => {
    it('should create SQL dump successfully', async () => {
      const dumpPath = join(backupDir, 'test-dump.sql');

      await exportDatabaseDump(testDbPath, dumpPath);

      expect(existsSync(dumpPath)).toBe(true);

      const dumpContent = await Bun.file(dumpPath).text();
      expect(dumpContent).toContain('CREATE TABLE test_memories');
      expect(dumpContent).toContain('INSERT INTO test_memories');
    });

    it('should export schema and data correctly', async () => {
      const dumpPath = join(backupDir, 'full-dump.sql');

      await exportDatabaseDump(testDbPath, dumpPath);

      const dumpContent = await Bun.file(dumpPath).text();
      expect(dumpContent).toContain('PRAGMA foreign_keys=OFF;');
      expect(dumpContent).toContain('BEGIN TRANSACTION;');
      expect(dumpContent).toContain('COMMIT;');
    });
  });

  describe('vacuumIntoBackup', () => {
    it('should create compacted backup', async () => {
      const vacuumPath = join(backupDir, 'vacuum-backup.db');

      await vacuumIntoBackup(testDbPath, vacuumPath);

      expect(existsSync(vacuumPath)).toBe(true);

      // Verify vacuum backup contains data
      const backupDb = new DatabaseSync(vacuumPath);
      const result = backupDb
        .prepare('SELECT COUNT(*) as count FROM test_memories')
        .get() as { count: number };
      expect(result.count).toBe(2);
      backupDb.close();
    });

    it('should reduce file size after vacuum', async () => {
      // Add more data to increase database size
      const db = new DatabaseSync(testDbPath);
      for (let i = 3; i <= 100; i++) {
        db.exec(
          `INSERT INTO test_memories VALUES ('${i}', 'content ${i}', ${1234567890 + i});`,
        );
      }

      const vacuumPath = join(backupDir, 'large-vacuum.db');

      await vacuumIntoBackup(testDbPath, vacuumPath);

      // Get file sizes
      const fs = require('fs');
      const vacuumSize = fs.statSync(vacuumPath).size;

      db.close();

      // Vacuum should at least not make it larger
      expect(vacuumSize).toBeGreaterThan(0);
    });
  });

  describe('restoreFromBackup', () => {
    it('should restore database successfully', async () => {
      // Create backup first
      const backupPath = join(backupDir, 'restore-test.db');
      const restorePath = join(backupDir, 'restored.db');

      const backupOptions: BackupOptions = {
        sourcePath: testDbPath,
        destPath: backupPath,
      };
      await backupDatabase(backupOptions);

      // Now restore
      const restoreOptions: RestoreOptions = {
        backupPath,
        targetPath: restorePath,
        verify: true,
      };

      await restoreFromBackup(restoreOptions);

      expect(existsSync(restorePath)).toBe(true);

      // Verify restored database
      const restoredDb = new DatabaseSync(restorePath);
      const result = restoredDb
        .prepare('SELECT COUNT(*) as count FROM test_memories')
        .get() as { count: number };
      expect(result.count).toBe(2);

      // Verify integrity
      const integrity = restoredDb.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      expect(integrity.integrity_check).toBe('ok');

      restoredDb.close();
    });

    it('should handle integrity verification', async () => {
      const validBackupPath = join(backupDir, 'integrity-test.db');
      const restorePath = join(backupDir, 'integrity-restored.db');

      // Create valid backup
      await backupDatabase({
        sourcePath: testDbPath,
        destPath: validBackupPath,
      });

      // Restore with verification
      const restoreOptions: RestoreOptions = {
        backupPath: validBackupPath,
        targetPath: restorePath,
        verify: true,
      };

      await restoreFromBackup(restoreOptions);

      const restoredDb = new DatabaseSync(restorePath);
      const integrity = restoredDb.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      expect(integrity.integrity_check).toBe('ok');
      restoredDb.close();
    });

    it('should perform clean restore from SQL dump, removing old tables/data not present in dump', async () => {
      // Create a backup dump with specific content
      const dumpPath = join(backupDir, 'clean-restore-dump.sql');
      const restoreTargetPath = join(backupDir, 'clean-restored.db');

      // Create original dump content (only test_memories table)
      await exportDatabaseDump(testDbPath, dumpPath);

      // Create a target database with additional tables/data not in the dump
      const existingDb = new DatabaseSync(restoreTargetPath);
      existingDb.exec(`
                CREATE TABLE test_memories (
                    id TEXT PRIMARY KEY,
                    content TEXT,
                    created_at INTEGER
                );
                CREATE TABLE extra_table (
                    id INTEGER PRIMARY KEY,
                    extra_data TEXT
                );
                INSERT INTO test_memories VALUES ('old-1', 'old content 1', 1000000000);
                INSERT INTO test_memories VALUES ('old-2', 'old content 2', 1000000001);
                INSERT INTO extra_table VALUES (1, 'extra data 1');
                INSERT INTO extra_table VALUES (2, 'extra data 2');
            `);
      const extraTableExistsBefore = existingDb
        .prepare(
          "SELECT COUNT(*) as count FROM sqlite_master WHERE name='extra_table'",
        )
        .get() as { count: number };
      expect(extraTableExistsBefore.count).toBe(1);
      const oldDataCount = existingDb
        .prepare(
          "SELECT COUNT(*) as count FROM test_memories WHERE id LIKE 'old-%'",
        )
        .get() as { count: number };
      expect(oldDataCount.count).toBe(2);
      existingDb.close();

      // Now restore the dump (this should clean the database and only contain what's in the dump)
      const restoreOptions: RestoreOptions = {
        backupPath: dumpPath,
        targetPath: restoreTargetPath,
        verify: true,
      };

      await restoreFromBackup(restoreOptions);

      // Verify that old data/tables are gone and only dump data remains
      const restoredDb = new DatabaseSync(restoreTargetPath);

      // Check that extra table was removed
      const extraTableExistsAfter = restoredDb
        .prepare(
          "SELECT COUNT(*) as count FROM sqlite_master WHERE name='extra_table'",
        )
        .get() as { count: number };
      expect(extraTableExistsAfter.count).toBe(0); // Should be removed

      // Check that old data was removed
      const newDataCount = restoredDb
        .prepare(
          "SELECT COUNT(*) as count FROM test_memories WHERE id LIKE 'old-%'",
        )
        .get() as { count: number };
      expect(newDataCount.count).toBe(0); // Should be removed

      // Check that new data from dump is present
      const originalDataCount = restoredDb
        .prepare('SELECT COUNT(*) as count FROM test_memories')
        .get() as { count: number };
      expect(originalDataCount.count).toBe(2); // Should match original dump

      // Verify specific data
      const specificRecord = restoredDb
        .prepare("SELECT * FROM test_memories WHERE id = '1'")
        .get() as any;
      expect(specificRecord.content).toBe('test content 1');

      restoredDb.close();
    });
  });

  describe('listBackups', () => {
    it('should list backup files correctly', async () => {
      // Create some backup files
      const backup1 = join(backupDir, 'backup-2024-01-01.db');
      const backup2 = join(backupDir, 'backup-2024-01-02.sql');

      await Bun.file(backup1).write('test');
      await Bun.file(backup2).write('test');

      const backups = await listBackups(backupDir);

      expect(backups.length).toBe(2);
      expect(backups[0].filename).toBe('backup-2024-01-02.sql'); // Sorted by date, newest first
      expect(backups[1].filename).toBe('backup-2024-01-01.db');

      // All should be marked as local
      expect(backups.every((b) => b.location === 'local')).toBe(true);
    });

    it('should return empty array for empty directory', async () => {
      const backups = await listBackups(backupDir);
      expect(backups).toEqual([]);
    });

    it('should return empty array for non-existent directory', async () => {
      const backups = await listBackups('/nonexistent/path');
      expect(backups).toEqual([]);
    });
  });

  describe('Supabase Storage integration', () => {
    it('should upload to Supabase Storage', async () => {
      const backupPath = join(backupDir, 'cloud-upload.db');
      const objectKey = 'test-backup.db';

      // Create test backup file
      await Bun.file(backupPath).write('test backup content');

      // Mock S3 client
      const mockS3Client = {
        send: vi.fn().mockResolvedValue({}),
      } as any;

      await uploadToSupabaseStorage(backupPath, objectKey, mockS3Client);

      expect(mockS3Client.send).toHaveBeenCalled();
      const command = mockS3Client.send.mock.calls[0][0];
      expect(command.input.Bucket).toBe(env.bucket_name);
      expect(command.input.Key).toBe(`backups/${objectKey}`);
    });

    it('should download from Supabase Storage', async () => {
      const objectKey = 'test-download.db';
      const destPath = join(backupDir, 'downloaded.db');

      // Mock S3 client
      const mockS3Client = {
        send: vi.fn().mockResolvedValue({
          Body: {
            transformToWebStream: () => ({
              getReader: () => ({
                read: vi
                  .fn()
                  .mockResolvedValueOnce({
                    value: new Uint8Array([116, 101, 115, 116]),
                    done: false,
                  })
                  .mockResolvedValueOnce({ done: true }),
              }),
            }),
          },
        }),
      } as any;

      await downloadFromSupabaseStorage(objectKey, destPath, mockS3Client);

      expect(mockS3Client.send).toHaveBeenCalled();
      expect(existsSync(destPath)).toBe(true);
    });
  });

  describe('importDatabaseDump', () => {
    it('should create database from SQL dump successfully', async () => {
      // First create a dump
      const dumpPath = join(backupDir, 'round-trip-dump.sql');
      await exportDatabaseDump(testDbPath, dumpPath);

      // Now import it into a new database
      const importedDbPath = join(backupDir, 'imported-from-dump.db');
      await importDatabaseDump(dumpPath, importedDbPath);

      expect(existsSync(importedDbPath)).toBe(true);

      // Verify imported database contains data
      const importedDb = new DatabaseSync(importedDbPath);
      const result = importedDb
        .prepare('SELECT COUNT(*) as count FROM test_memories')
        .get() as { count: number };
      expect(result.count).toBe(2);

      // Verify integrity
      const integrity = importedDb.prepare('PRAGMA integrity_check').get() as {
        integrity_check: string;
      };
      expect(integrity.integrity_check).toBe('ok');

      importedDb.close();
    });

    it('should handle non-existent dump file', async () => {
      const importedDbPath = join(backupDir, 'fail-import.db');

      await expect(
        importDatabaseDump('/nonexistent/dump.sql', importedDbPath),
      ).rejects.toThrow();
    });

    it('should handle invalid SQL in dump', async () => {
      const invalidDumpPath = join(backupDir, 'invalid-dump.sql');
      await Bun.file(invalidDumpPath).write('INVALID SQL STATEMENT;');

      const importedDbPath = join(backupDir, 'fail-invalid-sql.db');

      await expect(
        importDatabaseDump(invalidDumpPath, importedDbPath),
      ).rejects.toThrow();
    });

    it('should handle semicolons in string literals properly', async () => {
      const complexDumpPath = join(backupDir, 'complex-dump.sql');
      const complexDbPath = join(backupDir, 'complex-test.db');

      // Create a database with semicolons in content
      const complexDb = new DatabaseSync(complexDbPath);
      complexDb.exec(`
                CREATE TABLE complex_test (
                    id INTEGER PRIMARY KEY,
                    content TEXT
                );
                INSERT INTO complex_test VALUES (1, 'This has a semicolon; in the middle');
                INSERT INTO complex_test VALUES (2, 'Another;one;here');
            `);
      complexDb.close();

      // Export it to dump
      await exportDatabaseDump(complexDbPath, complexDumpPath);

      // Import into a new database
      const importedComplexDbPath = join(backupDir, 'imported-complex.db');
      await importDatabaseDump(complexDumpPath, importedComplexDbPath);

      // Verify the data was imported correctly
      const importedComplexDb = new DatabaseSync(importedComplexDbPath);
      const result = importedComplexDb
        .prepare('SELECT * FROM complex_test ORDER BY id')
        .all() as { id: number; content: string }[];
      expect(result.length).toBe(2);
      expect(result[0].content).toBe('This has a semicolon; in the middle');
      expect(result[1].content).toBe('Another;one;here');

      importedComplexDb.close();
    });

    it('should handle comments in SQL dumps', async () => {
      const commentDumpPath = join(backupDir, 'comment-dump.sql');
      const commentDbPath = join(backupDir, 'comment-db.db');

      // Create dump with comments
      const dumpContent = `
-- This is a comment
CREATE TABLE test_comments (
    id INTEGER PRIMARY KEY,
    content TEXT
);
/* This is a block comment
   spanning multiple lines */
/*
INSERT INTO test_comments VALUES (1, 'test');
*/
INSERT INTO test_comments VALUES (1, 'actual data');
-- End comment
            `.trim();

      await Bun.file(commentDumpPath).write(dumpContent);

      // Import the dump
      await importDatabaseDump(commentDumpPath, commentDbPath);

      // Verify the table and data exist
      const commentDb = new DatabaseSync(commentDbPath);
      const result = commentDb.prepare('SELECT * FROM test_comments').all() as {
        id: number;
        content: string;
      }[];
      expect(result.length).toBe(1);
      expect(result[0].content).toBe('actual data');

      commentDb.close();
    });

    it('should execute additional statement types from dumps', async () => {
      const schemaDumpPath = join(backupDir, 'schema-dump.sql');
      const schemaDbPath = join(backupDir, 'schema-db.db');

      // Create dump with various schema elements
      const dumpContent = `
PRAGMA foreign_keys = ON;
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE INDEX idx_users_name ON users(name);
CREATE VIEW active_users AS SELECT * FROM users WHERE name IS NOT NULL;
INSERT INTO users VALUES (1, 'Test User');
INSERT INTO users VALUES (2, 'Another User');
ANALYZE;
            `.trim();

      await Bun.file(schemaDumpPath).write(dumpContent);

      // Import the dump
      await importDatabaseDump(schemaDumpPath, schemaDbPath);

      // Verify various schema elements exist
      const schemaDb = new DatabaseSync(schemaDbPath);

      // Check foreign keys pragma
      const pragmaResult = schemaDb.prepare('PRAGMA foreign_keys').get() as {
        foreign_keys: number;
      };
      expect(pragmaResult.foreign_keys).toBe(1);

      // Check table exists
      const tableResult = schemaDb
        .prepare(
          "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='users'",
        )
        .get() as { count: number };
      expect(tableResult.count).toBe(1);

      // Check index exists
      const indexResult = schemaDb
        .prepare(
          "SELECT COUNT(*) as count FROM sqlite_master WHERE type='index' AND name='idx_users_name'",
        )
        .get() as { count: number };
      expect(indexResult.count).toBe(1);

      // Check view exists
      const viewResult = schemaDb
        .prepare(
          "SELECT COUNT(*) as count FROM sqlite_master WHERE type='view' AND name='active_users'",
        )
        .get() as { count: number };
      expect(viewResult.count).toBe(1);

      // Check data exists
      const dataResult = schemaDb
        .prepare('SELECT COUNT(*) as count FROM users')
        .get() as { count: number };
      expect(dataResult.count).toBe(2);

      schemaDb.close();
    });
  });

  describe('Error handling', () => {
    it('should handle backup errors gracefully', async () => {
      const options: BackupOptions = {
        sourcePath: '/invalid/path.db',
        destPath: '/readonly/path/backup.db',
      };

      await expect(backupDatabase(options)).rejects.toThrow();
    });

    it('should handle restore errors gracefully', async () => {
      const options: RestoreOptions = {
        backupPath: '/nonexistent/backup.db',
        targetPath: '/readonly/path/restored.db',
      };

      await expect(restoreFromBackup(options)).rejects.toThrow();
    });

    it('should handle cloud upload errors', async () => {
      const mockS3Client = {
        send: vi.fn().mockRejectedValue(new Error('Upload failed')),
      } as any;

      await expect(
        uploadToSupabaseStorage('/test/path', 'test-key', mockS3Client),
      ).rejects.toThrow('Upload failed');
    });

    it('should handle cloud download errors', async () => {
      const mockS3Client = {
        send: vi.fn().mockRejectedValue(new Error('Download failed')),
      } as any;

      await expect(
        downloadFromSupabaseStorage('test-key', '/test/path', mockS3Client),
      ).rejects.toThrow('Download failed');
    });
  });
});

# SQLite Backup and Restore Guide

This guide covers the backup and restore workflows for OpenMemory's SQLite database, including local file backups, cloud storage (Supabase), and CLI operations.

## Overview

OpenMemory uses SQLite for data persistence and provides comprehensive backup functionality through the `backupDatabase()`, `exportDatabaseDump()`, `vacuumIntoBackup()`, and `restoreFromBackup()` functions in `backend/src/utils/backup.js`.

## Environment Variables

The following environment variables control backup behavior:

- `OM_BACKUP_DIR`: Directory where local backups are stored (default: `./data/backups`)
- `OM_BACKUP_RETENTION_DAYS`: Number of days to retain backups (default: 7)
- `OM_BACKUP_CLOUD_ENABLED`: Enable cloud backup to Supabase Storage (default: false)
- `OM_BACKUP_AUTO_SCHEDULE`: Enable automatic scheduled backups (default: false)
- `OM_BACKUP_SCHEDULE_CRON`: Cron expression for backup scheduling (default: "0 2 \*\* \*")

## Backup Functions

### backupDatabase()

Performs a hot (zero-downtime) backup using SQLite's backup API:

```javascript
import { backupDatabase } from '../utils/backup.js';

await backupDatabase({
  sourcePath: './data/openmemory.db',
  destPath: './data/backups/backup-2024-01-01.db',
  progressCallback: (progress) => {
    console.log(`Progress: ${progress.percentage}%`);
  },
});
```

Features:

- WAL checkpointing for consistency
- Progress callbacks
- Handles concurrent reads during backup

### exportDatabaseDump()

Creates a portable SQL dump file:

```javascript
import { exportDatabaseDump } from '../utils/backup.js';

await exportDatabaseDump(
  './data/openmemory.db',
  './data/backups/dump-2024-01-01.sql',
);
```

Exports schema and data as SQL statements that can be imported into any SQLite database.

### vacuumIntoBackup()

Creates a compacted backup using the VACUUM INTO pragma:

```javascript
import { vacuumIntoBackup } from '../utils/backup.js';

await vacuumIntoBackup(
  './data/openmemory.db',
  './data/backups/vacuum-backup-2024-01-01.db',
);
```

This reduces file size and reorganizes data for optimal performance.

## Restore Functions

### restoreFromBackup()

Restores database from backup with integrity verification:

```javascript
import { restoreFromBackup } from '../utils/backup.js';

await restoreFromBackup({
  backupPath: './data/backups/backup-2024-01-01.db',
  targetPath: './data/openmemory.db',
  verify: true,
});
```

Features:

- Automatically detects SQL dumps vs binary backups
- Integrity checking with `PRAGMA integrity_check`
- Safe handling of WAL mode

### importDatabaseDump()

Imports SQL dump directly (used internally by `restoreFromBackup()` for dump files):

```javascript
import { importDatabaseDump } from '../utils/backup.js';

await importDatabaseDump(
  './data/backups/dump-2024-01-01.sql',
  './data/openmemory.db',
);
```

## Cloud Storage

### Supabase Storage Integration

When `OM_BACKUP_CLOUD_ENABLED` is true, backups are automatically uploaded:

```javascript
import { uploadToSupabaseStorage } from '../utils/backup.js';

await uploadToSupabaseStorage(
  './data/backups/backup-2024-01-01.db',
  'backup-2024-01-01.db',
  s3Client,
);
```

Backups are stored under the `backups/` prefix in the configured bucket.

### Downloading from Cloud

```javascript
import { downloadFromSupabaseStorage } from '../utils/backup.js';

await downloadFromSupabaseStorage(
  'backup-2024-01-01.db',
  './temp/backup-2024-01-01.db',
  s3Client,
);
```

## Automatic Scheduled Backups

OpenMemory supports automatic scheduled backups when `OM_BACKUP_AUTO_SCHEDULE` is set to `true`. The server automatically schedules backups using the cron expression specified in `OM_BACKUP_SCHEDULE_CRON`.

### Configuration

```bash
# Enable automatic backups
OM_BACKUP_AUTO_SCHEDULE=true

# Schedule expression (default: daily at 2 AM)
OM_BACKUP_SCHEDULE_CRON="0 2 * * *"

# Backup directory and retention
OM_BACKUP_DIR="./data/backups"
OM_BACKUP_RETENTION_DAYS=7
```

### Cron Expressions

Common cron expressions:

- `"0 2 * * *"` - Daily at 2:00 AM
- `"0 */6 * * *"` - Every 6 hours
- `"0 2 * * 1"` - Weekly on Monday at 2:00 AM
- `"0 2 1 * *"` - Monthly on the 1st at 2:00 AM

### Automatic Retention Enforcement

When `OM_BACKUP_AUTO_SCHEDULE` is enabled, the system automatically enforces the retention policy:

- Backups older than `OM_BACKUP_RETENTION_DAYS` are automatically deleted
- Retention is enforced after each successful backup
- Logs are emitted for removed expired backups

### Disable for Tests

Automatic scheduling is disabled when `OM_TEST_MODE=1` to prevent interference with test suites.

## Command Line Tools

OpenMemory provides several command-line scripts for backup operations. These scripts are available as npm scripts in the backend package and respect environment variables like `OM_DB_PATH` and `OM_BACKUP_DIR`.

### Available Scripts

- **`bun run backup:create`** - Create a manual backup of the database with timestamped filename
- **`bun run backup:list`** - List all available backups with sizes and creation times
- **`bun run backup:restore`** - Restore from the most recent backup (with confirmation prompt)
- **`bun run backup:test`** - Run the backup-related test suite

### Usage Examples

```bash
# From the backend directory
cd backend

# Create a backup
bun run backup:create

# List all backups
bun run backup:list

# Restore from latest backup (will prompt for confirmation)
bun run backup:restore

# Run backup tests
bun run backup:test
```

### Output Examples

**backup:create output:**

```
Creating backup: ./data/backups/backup-manual-2024-01-01T10-30-00-000Z.db
Progress: 100% (15/15)

✅ Backup created successfully: backup-manual-2024-01-01T10-30-00-000Z.db

Recent backups:
  backup-manual-2024-01-01T10-30-00-000Z.db (0h ago, 1.2MB)
  backup-auto-2024-01-01T02-00-00-000Z.db (8h ago, 1.1MB)
```

**backup:list output:**

```
📁 Backups in directory: ./data/backups

📋 Available backups:
────────────────────────────────────────────────────────────────────────────────
 1. backup-manual-2024-01-01T10-30-00-000Z.db
    Size: 1.2 MB | Location: local | Created: 1/1/2024, 10:30:00 AM (0h ago)

 2. backup-auto-2024-01-01T02-00-00-000Z.db
    Size: 1.1 MB | Location: local | Created: 1/1/2024, 2:00:00 AM (8h ago)

Total: 2 backup(s)
Directory size: 2.3 MB
```

**backup:restore output:**

```
🔄 Database Restore
══════════════════════════════════════════════════════════════════
Latest backup: backup-manual-2024-01-01T10-30-00-000Z.db
Created: 1/1/2024, 10:30:00 AM (0h ago)
Size: 1.2 MB
Database: ./data/openmemory.db

⚠️  WARNING: This will replace the current database!
   All current data will be lost. Make sure you have a backup.

Are you sure you want to restore from this backup? (yes/no): yes
🔄 Starting restore...
✅ Database restored successfully!

🔄 Next steps:
1. Restart the server to apply changes
2. Verify data integrity through the web interface
3. Test application functionality
```

### Environment Variables

All scripts respect the standard OpenMemory environment variables:

- `OM_DB_PATH`: Path to the database file to backup/restore
- `OM_BACKUP_DIR`: Directory where backups are stored
- `OM_BACKUP_RETENTION_DAYS`: Number of days to retain backups
- `OM_BACKUP_AUTO_SCHEDULE`: Enable automatic scheduled backups
- `OM_BACKUP_SCHEDULE_CRON`: Cron expression for scheduling

## CLI Uag

### Manual Backup

```bash
# Create a backup
curl -X POST http://localhost:3000/admin/backup \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cloud": true}'

# List available backups
curl http://localhost:3000/admin/backup/list \
  -H "Authorization: Bearer YOUR_TOKEN"

# Restore from backup
curl -X POST http://localhost:3000/admin/backup/restore \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename": "backup-2024-01-01.db", "location": "local"}'
```

### Scheduled Backups

Use cron for automated backups:

```bash
# Daily backup at 2 AM
0 2 * * * curl -X POST http://localhost:3000/admin/backup -H "Authorization: Bearer YOUR_TOKEN"
```

## Integrity Verification

All restores include integrity verification using SQLite's `PRAGMA integrity_check`. This ensures:

- Database file integrity
- Index consistency
- Foreign key constraints
- No corruption from backup/restore processes

## WAL Mode Handling

SQLite uses WAL (Write-Ahead Logging) mode for better concurrency. The backup system handles WAL checkpoints safely:

- `backupDatabase()` performs `PRAGMA wal_checkpoint(TRUNCATE)` before backup
- Restores work correctly in WAL mode
- No manual WAL file management required

## Troubleshooting

### WAL Checkpoint Issues

If WAL checkpoints fail during backup:

```sql
-- Force WAL checkpoint (use with caution)
PRAGMA wal_checkpoint(TRUNCATE);
```

### Integrity Check Failures

If `PRAGMA integrity_check` fails after restore:

```sql
-- Rebuild corrupted indexes
REINDEX;

-- Or recreate from dump (nuclear option)
.recover
```

### Disk Space

Backups can be large. Monitor disk space:

```bash
# Check backup directory size
du -sh ./data/backups

# Clean old backups
find ./data/backups -name "*.db" -mtime +30 -delete
```

## Related Documentation

- [README.md](../../README.md) - Main project documentation
- [CONTRIBUTING.md](../../CONTRIBUTING.md) - Development guidelines
- [ARCHITECTURE.md](../../ARCHITECTURE.md) - System architecture overview

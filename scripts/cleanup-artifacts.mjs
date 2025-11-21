#!/usr/bin/env bun
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = path.resolve(new URL(import.meta.url).pathname, '..', '..');

// Files/filename patterns to delete (RegExp)
const filePatterns = [
  /\.bak$/i,
  /~$/,
  /\.orig$/i,
  /\.backup$/i,
  /\.tmp$/i,
  /\.swp$/i,
  /^\.DS_Store$/i,
];

// Directories to skip completely
const skipDirs = new Set([
  '.git',
  'node_modules',
  'backend/dist',
  'data',
  'tmp',
  'tmp_restore',
  '.venv',
]);

let deleted = 0;

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    try {
      const full = path.join(dir, ent.name);
      const rel = path.relative(ROOT, full);
      // Skip excluded dirs
      if (ent.isDirectory()) {
        if (
          skipDirs.has(ent.name) ||
          rel.split(path.sep).some((p) => skipDirs.has(p))
        )
          continue;
        await walk(full);
        continue;
      }

      // Skip sqlite artifacts and other DB files
      if (
        /\.sqlite(\.|$)/i.test(ent.name) ||
        /\.(sqlite|sqlite-shm|sqlite-wal)$/i.test(ent.name)
      )
        continue;

      // Match patterns
      for (const pat of filePatterns) {
        if (pat.test(ent.name)) {
          await fs.unlink(full);
          console.log(`deleted: ${rel}`);
          deleted++;
          break;
        }
      }
    } catch (err) {
      console.error('error handling', ent.name, err);
    }
  }
}

async function main() {
  console.log(
    'Cleaning repository artifacts (safe patterns): .bak, .orig, ~, .backup, .tmp, .swp, .DS_Store',
  );
  await walk(ROOT);
  console.log(`Done. Deleted ${deleted} files.`);
}

main().catch((err) => {
  console.error('cleanup failed', err);
  process.exit(2);
});

#!/usr/bin/env bun
/**
 * Legacy wrapper for generate-benchmark-report.
 *
 * This script is a thin wrapper around scripts/benchmark-utils.ts for backwards compatibility.
 * The canonical implementation is scripts/benchmark-utils.ts.
 *
 * @deprecated Use scripts/benchmark-utils.ts report instead
 */

import { spawn } from 'child_process';
import path from 'path';

// Get the directory where this script is located
const scriptDir = path.dirname(import.meta.url.replace('file://', ''));

// Call the canonical implementation
const benchmarkUtils = path.join(scriptDir, 'benchmark-utils.ts');
const proc = spawn('bun', [benchmarkUtils, 'report'], {
  stdio: 'inherit',
  cwd: path.dirname(scriptDir), // Go up to repo root
});

proc.on('close', (code) => {
  process.exit(code || 0);
});

proc.on('error', (err) => {
  console.error('Failed to run benchmark report:', err);
  process.exit(1);
});

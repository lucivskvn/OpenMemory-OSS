#!/usr/bin/env bun
/**
 * Legacy wrapper for compare-benchmarks.
 *
 * This script is a thin wrapper around scripts/benchmark-utils.ts for backwards compatibility.
 * The canonical implementation is scripts/benchmark-utils.ts.
 *
 * @deprecated Use scripts/benchmark-utils.ts compare instead
 */

import { spawn } from 'child_process';
import path from 'path';

// Get the directory where this script is located
const scriptDir = path.dirname(import.meta.url.replace('file://', ''));

// Pass through all arguments to the canonical implementation
const args = process.argv.slice(2);
const benchmarkUtils = path.join(scriptDir, 'benchmark-utils.ts');

// Prepend 'compare' command
const proc = spawn('bun', [benchmarkUtils, 'compare', ...args], {
  stdio: 'inherit',
  cwd: path.dirname(scriptDir), // Go up to repo root
});

proc.on('close', (code) => {
  process.exit(code || 0);
});

proc.on('error', (err) => {
  console.error('Failed to run benchmark comparison:', err);
  process.exit(1);
});

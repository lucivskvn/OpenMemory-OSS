#!/usr/bin/env bun
/**
 * Consolidated benchmark utilities for OpenMemory testing.
 * Combines report generation, comparison, and artifact management.
 *
 * Usage:
 *   bun scripts/benchmark-utils.ts report          # Generate reports from latest results
 *   bun scripts/benchmark-utils.ts compare <prev>  # Compare current vs previous baseline
 *   bun scripts/benchmark-utils.ts cleanup         # Clean old benchmark artifacts
 *
 * @module benchmark-utils
 */

import fs from 'fs';
import path from 'path';

const root = path.resolve(
  path.dirname(import.meta.url.replace('file://', '')),
  '..',
);
const resultsDir = path.join(root, 'tests/benchmarks/results');
const e2eDir = path.join(root, 'tests/e2e/results');
const reportsDir = path.join(root, 'tests/benchmarks/reports');

/**
 * Read the most recent JSON file matching a prefix from a directory.
 * @param dir - Directory to search
 * @param prefix - Filename prefix to filter
 * @returns Parsed JSON object or null if no files found
 * @throws {SyntaxError} If file contents are invalid JSON
 */
function readLatestJson(dir: string, prefix: string): any {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();
  if (files.length === 0) return null;
  return JSON.parse(
    fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'),
  );
}

/**
 * Calculate percentage change between two numeric values.
 * @param current - Current measurement
 * @param previous - Previous measurement
 * @returns Percentage change (100% if previous is 0)
 * @throws {Error} (none expected) This is a pure function but it will throw for finite/infinite differences if input is not numeric
 */
function percentChange(current: number, previous: number): number {
  if (!previous || previous === 0) return 100;
  return ((current - previous) / previous) * 100;
}

/**
 * Generate HTML and Markdown reports from latest benchmark results.
 * @throws {Error} If the results directory is missing and cannot be created, or if JSON is invalid.
 * @example
 * ```bash
 * bun scripts/benchmark-utils.ts report
 * ```
 * Consolidates competitor comparison and E2E results.
 */
function generateReport(): void {
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const bench = readLatestJson(resultsDir, 'competitor-comparison-');
  const e2e = readLatestJson(e2eDir, 'e2e-');
  const aiSdk = readLatestJson(resultsDir, 'ai-sdk-');
  const now = new Date();
  const timestamp = Date.now();

  const consolidated = { timestamp: now.toISOString(), bench, e2e, aiSdk };
  fs.writeFileSync(
    path.join(reportsDir, `consolidated-${timestamp}.json`),
    JSON.stringify(consolidated, null, 2),
  );

  let md = `# Benchmark Summary - ${now.toISOString()}\n\n`;

  if (bench?.metrics) {
    const m = bench.metrics;
    md += `## Competitor Comparison\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Recall@5 | ${m.recall5} |\n`;
    md += `| Recall@10 | ${m.recall10} |\n`;
    md += `| P95 latency | ${m.p95}ms |\n`;
    md += `| QPS | ${Math.round(m.qps)} |\n`;
    md += `| Memory | ${Math.round(m.memUsage / 1024 / 1024)}MB |\n\n`;
  }

  if (aiSdk) {
    md += `## AI SDK Streaming\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| TTFT | ${aiSdk.ttft}ms |\n`;
    md += `| TPS | ${aiSdk.tps.toFixed(2)} |\n`;
    md += `| Total Time | ${aiSdk.totalTime}ms |\n`;
    md += `| Tokens | ${aiSdk.tokens} |\n\n`;
  }

  if (e2e) {
    md += `## E2E Results\n\n`;
    md += `| Metric | Value |\n|--------|-------|\n`;
    md += `| Errors | ${e2e.errors || 0} |\n`;
    md += `| Duration | ${e2e.duration || 'unknown'} |\n\n`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenMemory Benchmark Report</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #0066cc; padding-bottom: 0.5rem; }
    h2 { color: #333; margin-top: 2rem; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; font-weight: 600; }
    pre { background: #f8f8f8; padding: 1rem; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>🧠 OpenMemory Benchmark Report</h1>
  <pre>${md}</pre>
</body>
</html>`;

  fs.writeFileSync(path.join(reportsDir, `benchmark-${timestamp}.html`), html);
  fs.writeFileSync(path.join(reportsDir, `summary-${timestamp}.md`), md);

  console.log('✅ Generated benchmark reports in', reportsDir);
  console.log('  - consolidated-*.json');
  console.log('  - benchmark-*.html');
  console.log('  - summary-*.md');
}

/**
 * Compare current benchmark results against a previous baseline.
 * Detects regressions based on defined thresholds.
 * @param previousFile - Path to previous baseline JSON file
 * @throws {Error} If the file cannot be read or the JSON parsed
 * @example
 * ```bash
 * bun scripts/benchmark-utils.ts compare tests/benchmarks/results/baseline.json
 * ```
 */
function compareBaseline(previousFile?: string): void {
  const currentFiles = fs.existsSync(resultsDir)
    ? fs
        .readdirSync(resultsDir)
        .filter((f) => f.startsWith('competitor-comparison-'))
        .sort()
    : [];

  const current = currentFiles.pop();
  const currentJson = current
    ? JSON.parse(fs.readFileSync(path.join(resultsDir, current), 'utf8'))
    : null;

  if (!currentJson) {
    console.log('ℹ️  No current benchmark file found.');
    process.exit(0);
  }

  const previousJson =
    previousFile && fs.existsSync(previousFile)
      ? JSON.parse(fs.readFileSync(previousFile, 'utf8'))
      : null;

  if (!previousJson) {
    console.log('ℹ️  No previous benchmark to compare.');
    process.exit(0);
  }

  const curMetrics = currentJson.metrics || {};
  const curAiSdk = currentJson.aiSdk || {};
  const prevMetrics = previousJson.metrics || {};
  const prevAiSdk = previousJson.aiSdk || {};
  const regressions: string[] = [];
  const rows: string[] = [];

  // Competitor metrics
  const compMetrics = ['p95', 'recall5', 'qps', 'memUsage'];
  for (const m of compMetrics) {
    const c = curMetrics[m];
    const p = prevMetrics[m];
    const pc = percentChange(c, p);
    let verdict = '✅ OK';

    // Regression thresholds
    if (m === 'p95' && pc > 20) verdict = '❌ FAIL';
    if (m === 'recall5' && pc < -5) verdict = '❌ FAIL';

    if (verdict === '❌ FAIL') {
      regressions.push(`${m}: ${pc.toFixed(2)}%`);
    }

    rows.push(
      `| ${m} | ${p} | ${c} | ${pc > 0 ? '+' : ''}${pc.toFixed(2)}% | ${verdict} |`,
    );
  }

  // AI SDK metrics
  const aiSdkKeys = ['ttft', 'tps'];
  for (const m of aiSdkKeys) {
    const c = curAiSdk[m];
    const p = prevAiSdk[m];
    const pc = percentChange(c, p);
    let verdict = '✅ OK';

    // Thresholds: ttft +20% (higher worse), tps -20% (lower worse)
    if (m === 'ttft' && pc > 20) verdict = '❌ FAIL';
    if (m === 'tps' && pc < -20) verdict = '❌ FAIL';

    if (verdict === '❌ FAIL') {
      regressions.push(`${m}: ${pc.toFixed(2)}%`);
    }

    const displayC = typeof c === 'number' && m === 'tps' ? c.toFixed(2) : c;
    const displayP = typeof p === 'number' && m === 'tps' ? p.toFixed(2) : p;

    rows.push(
      `| ${m} | ${displayP} | ${displayC} | ${pc > 0 ? '+' : ''}${pc.toFixed(2)}% | ${verdict} |`,
    );
  }

  const md = `# Benchmark Comparison

| Metric | Previous | Current | Change | Status |
|--------|----------|---------|--------|--------|
${rows.join('\n')}

## Summary

${
  regressions.length === 0
    ? '✅ **No regressions detected** - All metrics within acceptable thresholds.'
    : '❌ **Regressions detected:**\n' +
      regressions.map((r) => `- ${r}`).join('\n')
}

### Thresholds
- **P95 latency**: +20% max increase
- **Recall@5**: -5% max decrease
`;

  const timestamp = Date.now();
  const outPath = path.join(reportsDir, `comparison-${timestamp}.md`);

  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  fs.writeFileSync(outPath, md);
  console.log(md);

  if (regressions.length > 0) {
    console.error('\n❌ Benchmark regression detected. Failing CI.');
    process.exit(1);
  } else {
    console.log('\n✅ All benchmarks passed.');
    process.exit(0);
  }
}

/**
 * Clean up old benchmark artifacts older than retention period.
 * Keeps last 30 days of results by default.
 */
function cleanupArtifacts(): void {
  const retentionDays = 30;
  const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const dirs = [resultsDir, reportsDir, e2eDir];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs
      .readdirSync(dir)
      .filter(
        (f) => f.endsWith('.json') || f.endsWith('.md') || f.endsWith('.html'),
      );

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);

      if (stats.mtimeMs < cutoffTime) {
        fs.unlinkSync(filePath);
        deleted++;
        console.log(`🗑️  Deleted: ${path.relative(root, filePath)}`);
      }
    }
  }

  console.log(
    `\n✅ Cleaned ${deleted} old artifact(s) (retention: ${retentionDays} days)`,
  );
}

/**
 * Main CLI entry point
 */
function main(): void {
  const command = process.argv[2];

  switch (command) {
    case 'report':
      generateReport();
      break;
    case 'compare':
      compareBaseline(process.argv[3]);
      break;
    case 'cleanup':
      cleanupArtifacts();
      break;
    default:
      console.error(`
Usage: bun scripts/benchmark-utils.ts <command> [args]

Commands:
  report           Generate HTML/MD reports from latest benchmark results
  compare <prev>   Compare current results vs previous baseline (optional path)
  cleanup          Remove benchmark artifacts older than 30 days

Examples:
  bun scripts/benchmark-utils.ts report
  bun scripts/benchmark-utils.ts compare tests/benchmarks/results/baseline.json
  bun scripts/benchmark-utils.ts cleanup
      `);
      process.exit(1);
  }
}

main();

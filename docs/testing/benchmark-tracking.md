# Benchmark Tracking Guide

This guide documents OpenMemory's benchmark methodology for regression detection, competitor comparisons, and performance tracking across local and CI environments.

## Overview

Benchmark tracking enables automated performance regression detection by running metrics against established baselines. Focus on key metrics: recall@K accuracy, latency percentiles, throughput, cost, and memory usage. Comparisons against Mem0, Zep, and synthetic baselines ensure parity with open-source competitors.

### Purpose

- Regression detection: Fail builds on >20% latency or >5% recall drop
- Competitor comparison: Track vs Mem0/Zep performance deltas
- Hardware baselines: Standardize on Linux Mint 22 (Ryzen 5 5600H) for reproducibility

### Integration

- CI: Ubuntu 24.04 jobs run benchmarks, upload results to artifacts
- Local: `bun run test:benchmarks` outputs JSON for manual review
- Reports: HTML/MD generation via `benchmark-utils.ts`

Reference `CONTRIBUTING.md` for testing setup and `docs/testing/linux-mint-22-testing.md` for full testing guide.

## Metrics

Core metrics measured across test suites:

### Recall Accuracy

- recall@5: Top-5 matches accuracy (target >=0.7 synthetic, >=0.85 hybrid)
- recall@10: Top-10 matches accuracy (consistency check)
- Cross-sector: Emotional ↔ semantic recall (target 5/5 matches)

### Latency

- P50/P95/P99: Per-query latency percentiles (P95 <50ms)
- TTFT: Time to first token (AI SDK: <500ms)
- TPS: Tokens per second (AI SDK: >20)

### Throughput

- QPS: Queries per second (target >200 synchronous)
- Response time: End-to-end query + embedding (avg <115ms @10k nodes)

### Cost

- Cost per 1M embeddings: Synthetic $0, OpenAI Hybrid $0.35
- Memory: SQLite <500MB, peak <600MB

### Memory Usage

- DB size: Stable scaling (7.9 ms/item beyond 10k entries)
- RAM: <600MB peak for full-stack operations

See `tests/benchmarks/competitor-comparison.test.ts` and `tests/backend/performance.test.ts` for implementations.

## Running Locally

Execute benchmarks on local Linux Mint 22 setup.

### Prerequisites

- Bun v1.3.2
- Build tools: `build-essential`, `libssl-dev`
- See `docs/testing/linux-mint-22-testing.md` for full setup

### Performance Test Considerations

**AI SDK benchmarks** (`tests/benchmarks/ai-sdk-benchmark.test.ts`) require a running dashboard instance and can be resource-intensive in local development. By default, they only run when `OM_RUN_PERF_TESTS=true`, but will skip if no dashboard is available and `OM_ALLOW_DASHBOARD_BUILD=true` is not set. For faster dev-loop feedback, start the dashboard manually before running perf tests.

```bash
# Option 1: Start dashboard manually (recommended for iterative testing)
cd dashboard && bun run dev

# Then in another terminal:
cd backend && OM_RUN_PERF_TESTS=true bun test ../tests/benchmarks/ai-sdk-benchmark.test.ts

# Option 2: Let test auto-manage dashboard lifecycle (resource intensive)
OM_RUN_PERF_TESTS=true OM_ALLOW_DASHBOARD_BUILD=true bun test ../tests/benchmarks/ai-sdk-benchmark.test.ts
```

### Command Line

```bash
cd backend
bun run test:benchmarks  # Full competitor tests with JSON output
bun run benchmark:embed  # SIMD-focused embedding perf
bun run benchmark:report # Generate HTML/MD reports from results/
```

### Results Format

JSON outputs to `tests/benchmarks/results/`:

```json
{
  "metric": "recall@5",
  "value": 0.95,
  "baseline": 0.9,
  "change_percent": 5.6,
  "status": "pass",
  "hardware": "Ryzen 5 5600H",
  "timestamp": "2025-11-18T06:30:00Z",
  "commit": "abc123"
}
```

### Viewing Reports

```bash
bun run benchmark:report  # Outputs consolidated.md and report.html
cat tests/benchmarks/results/consolidated.md  # View comparison table
```

Reports include:

- Metric changes with +/- indicators
- Status: 🟢 pass, 🟡 warning, 🔴 fail
- Historical trends vs baselines

## CI Integration

Automated benchmark execution on Ubuntu 24.04.

### Job Configuration

See `.github/workflows/ci.yml` benchmark job:

- Hardware: 2-core Ubuntu 24.04 runner
- Triggers: Every PR and main branch push
- Artifacts: 90-day retention for comparison-\*.json/md

### Assertions

- Fail on thresholds: P95 latency +20%, recall@5 -5%, QPS -30%, memory +40%
- Generate comparison.md for PR comments
- Download previous runs via GitHub API for historical comparison

### Security

- SARIF uploads for Trivy scans
- SLSA attestations for built images
- OIDC permissions scoped to benchmark job

See `docs/security/github-actions-hardening.md` for SHA pins and provenance.

## Viewing CI Results

### Artifacts

1. Go to PR checks → benchmark job → Artifacts
2. Download `benchmark-results.zip`
3. Extract and view `comparison.md` and JSON files

### Baseline Evolution

Current baselines (Nov 2025):

- Mem0: recall@5 0.88, latency 250ms avg, QPS 150
- Zep: recall@5 0.91, latency 310ms avg, QPS 180
- OpenMemory: recall@5 0.95, latency 115ms avg, QPS 338

Updates require manual PR with new baseline JSON committed to `tests/benchmarks/baselines/` and regression threshold adjustments in CI.

### Hardware Notes

- CI: 2-core e2-standard-2 (7GB RAM) - scale metrics accordingly
- Local: Ryzen 5 5600H, 16GB RAM - production-grade hardware baseline

Reference `tests/benchmarks/competitor-comparison.test.ts` for synthetic Mem0/Zep simulations using local models.

## Troubleshooting

### JSON Output Issues

```bash
# Check result structure
jq . tests/benchmarks/results/*.json
# Ensure Bun v1.3.2 compatibility
bun --version
```

### CI Artifacts Missing

- Check job logs for failures
- Verify 90-day retention policy
- Re-run workflow if needed

### Baseline Updates

Update baselines quarterly with representative hardware samples:

```bash
# Generate new baseline
bun run test:benchmarks --output-baseline
# Commit to tests/benchmarks/baselines/latest.json
# Adjust thresholds in ci.yml
```

### SIMD Performance Variance

On CPU-only runs, SIMD changes (~20-30% improvement) may cause variance:

```bash
# Disable SIMD for consistent baselines
OM_SIMD_ENABLED=false bun run benchmark:embed
```

See `AGENTS.md` for Bun-first patterns and `CHANGELOG.md` for benchmark-related updates.

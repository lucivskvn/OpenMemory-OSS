# GitHub Actions Security Hardening

This document describes OpenMemory's GitHub Actions hardening guidance: SHA-pinning, minimal permissions, OIDC, SLSA attestations, and security scanning.

## SHA Pinning

Use full 40-character commit SHAs for `uses:` entries to avoid tag takeover and supply-chain attacks. Example:

```yaml
uses: actions/checkout@2c5d1f90b8b0f5e8f7e5a1c7ad8b1f0a12345678 # pinned to a specific commit
```

## Minimal Permissions

Set `permissions:` at workflow/job level to the least-privilege required. Example:

```yaml
permissions:
  contents: read
  id-token: write
  packages: write
  attestations: write
```

## OIDC and SLSA

Use least-privilege job-level permissions and only grant `id-token: write` to jobs that need to exchange OIDC tokens with cloud providers. Keep job-level `id-token` access disabled for forks and PRs originating from external contributors.

SLSA attestations: use `actions/attest-build-provenance` pinned to a SHA for generating attestations during official production builds. Upload attestations to your artifact registry alongside images and artifacts to enable supply-chain verification.

Configure OIDC trust in cloud providers and add SLSA attestations for build provenance.

## Security Scanning

Integrate Trivy and Bun dependency scanning in CI. Upload SARIF to Security tab for imagery and file system scans. Use `bun pm ls --all` and `bun pm outdated` during CI to detect out-of-date dependencies.

### Linux Mint 22 CI notes

Use `ubuntu-24.04` runner to exercise Mint 22 compatibility. Add a compatibility matrix job that runs basic smoke tests using `bun test` and Podman GPU passthrough smoke tests on self-hosted runners with GPUs if you run hardware-in-the-loop testing.

### Testing on Ubuntu 24.04 (Linux Mint 22 Base)

All CI workflows should prefer `ubuntu-24.04` runners for Mint 22 parity. Use SHA-pinned Bun setup and prefer `bun install --frozen-lockfile --no-save` to ensure reproducible installs.

- Use `oven-sh/setup-bun@<sha>` pinned to 1.3.2
- Set `OM_TEST_MODE=1`, `OM_SKIP_BACKGROUND=true` for test runs; gate heavy benchmarks with `OM_RUN_BENCHMARK_TESTS=true`.

Recommended runner configuration:

- `runs-on: ubuntu-24.04` (match Mint 22 base)
- Use `oven-sh/setup-bun@<sha>` pinned to 1.3.2
- Set `OM_TEST_MODE=1`, `OM_SKIP_BACKGROUND=true` for test runs; gate heavy benchmarks with `OM_RUN_BENCHMARK_TESTS=true`.

- Performance & benchmark guidance:

- Gate expensive benchmarks with `OM_RUN_BENCHMARK_TESTS=true` in jobs that are explicitly allowed to run long (e.g., nightly or PR with performance flag).
- Upload benchmark artifacts (JSON + HTML reports) as 90-day artifacts.
- Compare current vs baseline using `scripts/compare-benchmarks.ts` and fail CI if regressions exceed thresholds.

- Security considerations:

- Limit `pull-requests: write` only to the job that posts performance comments (use token scoping carefully).
- Avoid leaking environment variables from forks when artifacts or comparisons include private baseline artifacts.

## Example commented-out jobs for additional security hardening

The following are example commented-out job stubs for SLSA attestations, Trivy scans, and Bun dependency checks. Move to your CI workflow (e.g., .github/workflows/ci.yml) when enabling.

```yaml
# Example SLSA attestation job – move to ci.yml when enabling
slsa-attestation:
  runs-on: ubuntu-latest
  needs: build-image
  permissions:
    id-token: write
    attestations: write
  steps:
    - name: Generate SLSA attestation
      uses: actions/attest-build-provenance@88d7aab2c5ed3c3edbd28e8c79bd9e8db0e67e9a # v1.3.1
      with:
        subject-path: openmemory-image.tar

# Example Trivy scan job – move to ci.yml when enabling
trivy-scan:
  runs-on: ubuntu-latest
  permissions:
    contents: read
    security-events: write
  steps:
    - name: Checkout
      uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
    - name: Run Trivy vulnerability scanner
      uses: aquasecurity/trivy-action@4f489e7c748182ae0fd45e518cd9c67ed7f6c8abd # 0.21.0
      with:
        scan-type: fs
        scan-ref: .
        format: sarif
        output: trivy-results.sarif
    - name: Upload SARIF file
      uses: github/codeql-action/upload-sarif@1b1aada464948af03b950897e5eb77a9 # v3.24.9
      if: always()
      with:
        sarif_file: trivy-results.sarif

# Example Bun dependency check job – move to ci.yml when enabling
bun-deps-check:
  runs-on: ubuntu-latest
  permissions:
    contents: read
  steps:
    - name: Checkout
      uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
    - name: Setup Bun
      uses: oven-sh/setup-bun@4bc047ad259df6fc24aac5a013092c62a6e81c8ae # v1.0.0
      with:
        bun-version: v1.3.2
    - name: Check outdated dependencies
      run: bun pm ls --all && bun pm outdated
```

## Checklist

- [ ] SHA-pin all actions
- [ ] Set minimal permissions
- [ ] Add Trivy scan job
- [ ] Enable Dependabot for actions, npm, docker
- [ ] Generate SLSA attestations for published artifacts
- [ ] Add ubuntu-24.04 compatibility tests for Mint 22 and GPU passthrough checks in CI (optional; requires self-hosted runners)

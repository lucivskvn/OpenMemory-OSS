# GitHub Actions Security Hardening

This document describes OpenMemory's GitHub Actions hardening guidance: SHA-pinning, minimal permissions, OIDC, SLSA attestations, and security scanning.

## SHA Pinning

Use full 40-character commit SHAs for `uses:` entries to avoid tag takeover and supply-chain attacks.

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

Configure OIDC trust in cloud providers and add SLSA attestations for build provenance.

## Security Scanning

Integrate Trivy and Bun dependency scanning in CI. Upload SARIF to Security tab.

## Checklist

- [ ] SHA-pin all actions
- [ ] Set minimal permissions
- [ ] Add Trivy scan job
- [ ] Enable Dependabot for actions, npm, docker
- [ ] Generate SLSA attestations for published artifacts

# OIDC Setup for GitHub Actions

This document describes how to configure OIDC for cloud providers (AWS, GCP, Azure) so GitHub Actions can assume short-lived credentials without long-lived secrets.

(See plan for full checklist and examples.)

# OIDC Setup and Examples

This guide shows how to configure GitHub Actions OIDC for common cloud providers (AWS, GCP, Azure). It includes ready-to-copy trust policies and workflow snippets. Use OIDC to move away from long-lived cloud secrets and enable short-lived, auditable credentials for CI.

## Overview

- Benefits: no long-lived secrets in GitHub, improved rotation, auditable short-lived credentials, and better SLSA/OIDC integration.
- Prerequisites: repo admin permissions for creating federated credentials in cloud provider and `id-token: write` permission on the job needing credentials.

## AWS (IAM Role with OIDC)

1. Create an IAM OIDC identity provider using `https://token.actions.githubusercontent.com`.
2. Create an IAM role with the following trust policy (replace `ACCOUNT_ID`, `ORG`, and `REPO`):

```json
{
 "Version": "2012-10-17",
 "Statement": [{
  "Effect": "Allow",
  "Principal": {"Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"},
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
   "StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com"},
   "StringLike": {"token.actions.githubusercontent.com:sub": "repo:ORG/REPO:*"}
  }
 }]
}
```

3. Attach minimal policies to the role (e.g., `AmazonEC2ContainerRegistryPowerUser` for ECR push).

4. Workflow snippet (SHA-pinned action recommended):

```yaml
- name: Configure AWS credentials
 uses: aws-actions/configure-aws-credentials@0e5d66e0e7a4e8d4f8b0c8e4f5a6b7c8d9e0f1a2 # v4.x
 with:
  role-to-assume: arn:aws:iam::ACCOUNT_ID:role/gh-actions
  aws-region: us-east-1
```

## GCP (Workload Identity Federation)

1. Create a Workload Identity Pool and Provider in GCP.
2. Create a service account and grant it the required roles.
3. Allow the provider to impersonate the service account.

Workflow snippet (SHA-pinned):

```yaml
- name: Authenticate to GCP
 uses: google-github-actions/auth@d3f6a5b3f7e3a8f7f1a2b3c4d5e6f7a8b9c0d1e2 # v0.6.x
 with:
  workload_identity_provider: projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER
  service_account: my-service-account@project.iam.gserviceaccount.com
```

## Azure (Federated Credential)

1. Register an App in Azure AD and create a Federated Credential that trusts `https://token.actions.githubusercontent.com`.
2. Configure the `subject` to `repo:ORG/REPO:ref:refs/heads/main` or a wildcard as appropriate.
3. Assign RBAC roles to the App's service principal.

Workflow snippet (SHA-pinned):

```yaml
- name: Login to Azure
 uses: azure/login@5a7b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8 # v1.x
 with:
  client-id: ${{ secrets.AZURE_CLIENT_ID }} # only for initial setup; remove after testing
  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

## Workflow integration notes

- Ensure the specific job has `permissions: id-token: write` (job-level) and `contents: read` minimal top-level permissions.
- Use SHA-pinned action versions when possible for supply-chain hygiene.

## Bun.secrets and local secrets management

For local development, prefer `Bun.secrets` when possible to avoid storing secrets in plain-text `.env` files.

```javascript
// Access secrets via Bun.secrets.get('MY_SECRET')
const jwtSecret = Bun.secrets.get('OM_JWT_SECRET') || process.env.OM_JWT_SECRET;
```

In production use a system secrets manager (AWS Secrets Manager, Vault, GCP Secret Manager) and inject secrets into the GitHub Actions job via cloud-specific OIDC credentials rather than repo secrets. The `backend/scripts/hash-api-key.ts` helper supports hashing a plaintext API key for secure storage in `OM_API_KEY`.

## Application OIDC configuration (Linux Mint 22 / Ubuntu 24.04)

When deploying OpenMemory on Linux Mint 22 (Ubuntu 24.04), you can enable JWT-based authentication by configuring OIDC providers. Unlike GitHub Actions OIDC which is cloud-focused, this configures the application itself to accept JWT tokens from identity providers.

### Environment Variables

Set the following in your OpenMemory environment:

```bash
# Required for JWT mode
OM_AUTH_PROVIDER=jwt
OM_JWT_SECRET=your-jwt-signing-secret-or-jwks-url
OM_JWT_ISSUER=https://your-identity-provider.com
OM_JWT_AUDIENCE=urn:openmemory:production

# Optional: For Supabase managed auth instead
OM_AUTH_PROVIDER=supabase
```

**Note:** See JWT/OIDC vs HTTP API key behavior in SECURITY.md. Ensure `OM_API_KEY` remains configured when using JWT/OIDC features.

**Note:** Missing `OM_JWT_SECRET` will prevent startup in production modes (production/standard/langgraph). See `SECURITY.md` and `backend/src/core/cfg.ts` for detailed behavior and validation logic.

### Loading Secrets on Mint 22

#### Option 1: systemd User Environment File

Create a user-specific environment file:

```bash
# Create directory for systemd user files
mkdir -p ~/.config/systemd/user

# Create environment file for OpenMemory
cat > ~/.config/systemd/user/openmemory.env << EOF
OM_AUTH_PROVIDER=jwt
OM_JWT_SECRET=your-secure-secret-here
OM_JWT_ISSUER=https://auth.yourdomain.com
OM_JWT_AUDIENCE=openmemory-prod
EOF

# Make the file readable only by owner
chmod 600 ~/.config/systemd/user/openmemory.env
```

Then reference it in your systemd service unit file:

```ini
[Service]
EnvironmentFile=%h/.config/systemd/user/openmemory.env
```

#### Option 2: Podman Quadlet .env File

If using Podman quadlets, load from a `.env` file:

```bash
# .env file in your deployment directory
OM_AUTH_PROVIDER=jwt
OM_JWT_SECRET=your-secure-secret-here
OM_JWT_ISSUER=https://auth.yourdomain.com
OM_JWT_AUDIENCE=openmemory-prod
```

#### Option 3: Bun.secrets (Recommended for Local Development)

For local development, use Bun's built-in secrets management:

```bash
# Set secrets (these persist across sessions)
bun run --env-file .env bun -e "
Bun.secrets.set('OM_JWT_SECRET', 'your-secret-here');
Bun.secrets.set('OM_JWT_ISSUER', 'https://auth.yourdomain.com');
Bun.secrets.set('OM_JWT_AUDIENCE', 'openmemory-prod');
"
```

The application will automatically use `Bun.secrets.get()` as a fallback to `process.env`.

### Production Secrets

For production deployments, prefer a dedicated secrets manager:

- **AWS**: Use AWS Secrets Manager with OIDC-assumed roles
- **Vault**: HashiCorp Vault with AppRole or Kubernetes auth
- **GCP**: Secret Manager with workload identity
- **Azure**: Key Vault with managed identity

### Security Notes

- Regularly rotate `OM_JWT_SECRET` keys
- Always validate `iss` and `aud` claims in JWT tokens
- Store secrets encrypted at rest
- Use hardware security modules (HSM) for critical deployments
- See `SECURITY.md` for additional JWT hardening practices
- Refer to `backend/src/core/cfg.ts` for complete environment variable validation

## Migration checklist

- [ ] Create cloud-side OIDC provider and role/service-account
- [ ] Add job-level `permissions: id-token: write` to the workflow jobs that need cloud access
- [ ] Replace uses of repository secrets with federated role assumptions in workflows
- [ ] Test on a non-production branch and validate claims in the cloud audit logs
- [ ] Remove plain-text secrets from repository (with a 30-day rollback window)

## Troubleshooting

- `AccessDenied`: verify the role's attached policies and that the `sub` and `aud` claims match the provider trust policy.
- `token validation failed`: confirm `token.actions.githubusercontent.com` is the issuer and `aud` is `sts.amazonaws.com` for AWS.
- Check cloud provider audit logs to see which claim was rejected.

- [ ] Create OIDC provider in cloud
- [ ] Create minimal-permission role/service-account
- [ ] Update workflows to request id-token: write
- [ ] Replace secret-based steps with OIDC-based login
- [ ] Remove old long-lived credentials after verification

```

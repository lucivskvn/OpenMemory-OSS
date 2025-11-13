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

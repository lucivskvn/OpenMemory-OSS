# Security Policy

## Supported Versions

We actively support the following versions of OpenMemory with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 2.0.x   | :white_check_mark: |
| 1.x.x   | :x:                |

## Reporting a Vulnerability

We take the security of OpenMemory seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Where to Report

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of the following methods:

1. **Email**: Send an email to [security@cavira.app](mailto:security@cavira.app)
2. **GitHub Security Advisories**: Use the [GitHub Security Advisory](https://github.com/lucivskvn/openmemory-OSS/security/advisories) feature
3. **Private disclosure**: Contact maintainers directly for sensitive issues

### What to Include

Please include the following information in your report:

- **Description**: A clear description of the vulnerability
- **Impact**: The potential impact of the vulnerability
- **Reproduction**: Step-by-step instructions to reproduce the issue
- **Affected versions**: Which versions of OpenMemory are affected
- **Suggested fix**: If you have suggestions for how to fix the issue
- **Your contact information**: So we can follow up with questions

### Response Timeline

We aim to respond to security reports within the following timeframes:

- **Initial response**: Within 48 hours
- **Assessment completion**: Within 7 days
- **Fix development**: Within 30 days (depending on complexity)
- **Public disclosure**: After fix is released and users have time to update

### Security Update Process

1. **Vulnerability confirmed**: We verify the reported vulnerability
2. **Fix development**: We develop and test a security fix
3. **Security advisory**: We prepare a security advisory
4. **Coordinated disclosure**: We release the fix and advisory together
5. **CVE assignment**: We request a CVE if applicable

## Security Best Practices

### For Users

#### Server Security

- **Authentication**: Always use authentication in production
- **HTTPS**: Use HTTPS/TLS for all communications
- **Network isolation**: Run OpenMemory behind a firewall
- **Regular updates**: Keep OpenMemory updated to the latest version
- **Environment variables**: Store sensitive configuration in environment variables
- **Access control**: Limit access to the OpenMemory server

### Platform-specific hardening (Linux Mint 22 / Ubuntu 24.04)

- **Unattended upgrades**: enable `unattended-upgrades` and configure email notifications for security updates
- **UFW**: restrict ports using `ufw` and only open the ones required by your deployment (default: 8080 for HTTP/API; disable or restrict OM_OLLAMA_URL for sidecar)
- **SELinux/AppArmor**: on distributions which support it, enforce AppArmor/SELinux confinement for container runtimes
- **Podman rootless**: ensure subuid/subgid are configured and the user is in proper groups; prefer rootless Podman for security isolation
- **Driver updates**: install GPU drivers from trusted vendor packages and keep them updated (NVIDIA/AMD). Test containerized GPU workloads with `nvidia-smi`/`vulkaninfo`.
- **Critical packages**: Keep `build-essential` and `libssl-dev` installed and updated for Bun native dependencies and OpenSSL-linked components.

#### API Key Security

- **Secure storage**: Store embedding provider API keys securely
- **Rotation**: Rotate API keys regularly
- **Least privilege**: Use API keys with minimal required permissions
- **Monitoring**: Monitor API key usage for anomalies

#### Data Protection

- **Input validation**: Validate all inputs before storing
- **Sensitive data**: Avoid storing sensitive personal information
- **Backup security**: Secure database backups
- **Audit logging**: Enable audit logging for security events

## Universal Postgres, Auth, and Bucket Hardening Practices

### Postgres Security

#### Connection Security

- **SSL/TLS encryption**: Always use `sslmode=require` or `sslmode=verify-full` for production Postgres connections
- **SSL configuration via connection string**: Prefer `sslmode` parameters in `OM_PG_CONNECTION_STRING` for SSL/TLS control; treat `OM_PG_SSL` as a legacy/discrete environment option
- **Connection pooling**: Use managed connection poolers (pgbouncer, supavisor) to prevent connection exhaustion attacks
- **LibPQ URIs**: Use connection strings for easier credential rotation and centralized management
- **Network isolation**: Run Postgres behind private networks, never expose directly to public internet

#### Access Control

- **Row Level Security (RLS)**: Enable RLS policies for multi-tenant setups with user-scoped data access
- **Prepared statements**: Leverage Postgres prepared statements for SQL injection prevention
- **Least privilege**: Use dedicated database users with minimal required permissions

### Authentication & Authorization Security

#### JWT/OIDC Configuration

- **Secret rotation**: Regularly rotate JWT signing keys and use hardware security modules when possible
- **Issuer validation**: Always validate JWT `iss` and `aud` claims to prevent token confusion attacks
- **Secure storage**: Store signing keys in dedicated secrets management systems (Bun.secrets, HashiCorp Vault, AWS KMS)
- **Token expiration**: Enforce reasonable token expiration times (`exp` claims)

#### Provider Selection

- **OIDC integration**: Prefer OIDC-compliant identity providers over custom authentication
- **JWT/OIDC vs HTTP API key**: JWT/OIDC support currently applies to PostgREST/RLS and external services only; the OpenMemory HTTP API continues to require an API key. JWT-related environment variables influence startup validation and database configuration but do not change HTTP request authentication behavior.
- **supabase/jwt modes**: Use `OM_AUTH_PROVIDER=jwt` for self-hosted OIDC (requires explicit setting; unset OM_AUTH_PROVIDER defaults to API-key-only authentication) or `OM_AUTH_PROVIDER=supabase` for Supabase-managed auth

### S3-Compatible Bucket Security

#### Encryption and Access

- **Server-side encryption**: Enable encryption at rest for all stored objects
- **Transport encryption**: Use HTTPS/TLS for all bucket communications
- **Bucket policies**: Implement restrictive bucket policies to limit public access
- **Access key rotation**: Regularly rotate bucket access keys and use temporary tokens

#### Data Lifecycle

- **Lifecycle rules**: Configure automatic deletion of old or unnecessary data
- **Auditing**: Enable access logging and monitoring for bucket operations
- **Backup strategies**: Implement cross-region replication for critical data

### Monitoring and Auditing

#### Security Monitoring

- **Connection logging**: Monitor database connection patterns for anomaly detection
- **Authentication failures**: Log and alert on authentication failures
- **Bucket access**: Monitor unusual bucket access patterns

#### Compliance Considerations

- **GDPR/HIPAA**: Implement appropriate data handling for regulated environments
- **Audit trails**: Maintain comprehensive logs of admin operations and API key usage
- **Incident response**: Have documented procedures for security incidents

### Runtime Configuration Validation

OpenMemory performs startup validation of auth and bucket configurations to prevent misconfigurations, especially in production environments. At launch, check logs for `[CFG]` prefixed messages that indicate configuration issues.

**Authentication Validation:**

- `OM_TEST_MODE=1` suppresses the hard process exit when `OM_AUTH_PROVIDER=jwt` is configured without `OM_JWT_SECRET`, allowing automated tests to run without pre-configured JWT secrets. `OM_TEST_MODE` is a testing-only escape hatch and must not be set in production deployments.
- When `OM_AUTH_PROVIDER=jwt` is set without `OM_JWT_SECRET`, production modes (production/standard/langgraph) will exit with code 1 for safety, while development mode logs a warning and continues with API-key authentication fallback.
- Example log: `[CFG] OM_AUTH_PROVIDER=jwt requires OM_JWT_SECRET; exiting for safety in production mode.`

**Bucket Validation:**

- Misconfigured bucket providers emit warnings only and do not exit the process; bucket functionality is disabled until credentials are properly configured
- When bucket provider is configured, S3 buckets require `OM_BUCKET_ACCESS_KEY` and `OM_BUCKET_SECRET_KEY` (endpoint/region optional for AWS defaults)
- Non-S3 providers require `OM_BUCKET_ENDPOINT`, `OM_BUCKET_ACCESS_KEY`, and `OM_BUCKET_SECRET_KEY`
- Example log: `[CFG] OM_BUCKET_PROVIDER=s3 requires OM_BUCKET_ACCESS_KEY and OM_BUCKET_SECRET_KEY (endpoint/region optional for AWS defaults); bucket functionality will be disabled.`

**Startup Behavior:**

- Development mode: Warnings logged, service continues with degraded functionality
- Production modes: Fatal errors cause immediate exit
- Check startup logs after configuration changes to interpret validation results

### Configuration Examples

```bash
# Secure Postgres connection
OM_PG_CONNECTION_STRING=postgresql://user:password@host:5432/db?sslmode=verify-full

# JWT configuration
OM_AUTH_PROVIDER=jwt
OM_JWT_SECRET=$SECURE_ROTATED_SECRET
OM_JWT_ISSUER=https://auth.company.com
OM_JWT_AUDIENCE=urn:openmemory:prod

# Bucket security
OM_BUCKET_PROVIDER=s3
OM_BUCKET_ENCRYPTION=true
OM_BUCKET_ACCESS_LOGGING=true
```

### For Developers

#### Code Security

- **Input sanitization**: Sanitize all user inputs
- **SQL injection prevention**: Use parameterized queries
- **XSS prevention**: Escape output appropriately
- **CSRF protection**: Implement CSRF protection
- **Rate limiting**: Implement rate limiting on API endpoints

#### Dependency Security

- **Regular updates**: Keep dependencies updated
- **Vulnerability scanning**: Regularly scan for vulnerable dependencies
- **Minimal dependencies**: Use minimal required dependencies
- **License compliance**: Ensure dependency licenses are compatible

#### Development Security

- **Secure coding practices**: Follow secure coding guidelines
- **Code review**: Require security-focused code reviews
- **Static analysis**: Use static analysis tools
- **Secrets management**: Never commit secrets to version control

### Multi-tenant security

- **Tenant enforcement**: Ensure `OM_STRICT_TENANT=true` is set in multi-tenant deployments when user-scoped isolation is required;
- **Row-level security (RLS)**: When using PostgreSQL, enable RLS policies to scope reads/writes to `user_id` to ensure tenant separation. See `docs/deployment/universal-postgres-auth-bucket.md` for examples.
- **Audit logging**: Keep a record of admin operations and API keys usage for forensic analysis; consider integrating with existing SIEM tools.

## Questions?

If you have any questions about this security policy, please contact us at [security@cavira.app](mailto:security@cavira.app) or create a GitHub discussion in the repository.

Thank you for helping keep OpenMemory and our users safe!

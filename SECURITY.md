# Security Policy

## Supported Versions

Use the latest stable version of OpenMemory to ensure you have the most up-to-date security patches.

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| 1.x     | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within this project, please report it privately.

**DO NOT** open a public GitHub issue.

- **Email**: security@openmemory.ai
- **Response Time**: We aim to acknowledge reports within 48 hours.

## Security Features

OpenMemory implements a "Secure by Default" philosophy.

### 1. Authentication
- **Fail-Closed**: The system defaults to denying access ("Fail-Closed") if authentication keys are missing or invalid.
- **Timing-Safe**: API key validation uses constant-time comparison algorithms to prevent timing attacks.
- **Hashing**: Client IDs and Keys are hashed using SHA-256 before storage or comparison.

### 2. Data Protection
- **Encryption**: Optional AES-256-GCM encryption for stored memories (`OM_ENCRYPTION_ENABLED=true`).
- **Key Rotation**: Supports encryption key rotation (pending v1.11 schema).
- **Isolation**: Tenant data is logically isolated by `user_id` enforced at the database query layer.

### 3. Rate Limiting
- **Adaptive Throttling**: The API implements strictly enforced rate limiting (default: 100 req/min).
- **Fail-Closed Strategy**: In distributed deployments, if the rate-limit store (Redis) is unavailable, the system denies requests to prevent abuse.

### 4. Input Validation
- **Strict Typing**: All inputs are validated against Zod schemas (TS) or Pydantic models (Python).
- **SQL Injection Prevention**: All database queries use parameterized statements.
- **Payload Limits**: strictly enforced 10MB limit on `web_crawler` and API bodies to prevent DoS/OOM attacks.

## Best Practices for Deployment

1.  **Enable Encryption**: Set `OM_ENCRYPTION_ENABLED=true` and provide a strong `OM_ENCRYPTION_KEY`.
2.  **Use TLS**: Always terminate SSL/TLS at your load balancer or reverse proxy.
3.  **Rotate Keys**: Regularly rotate your `OM_API_KEY` and Service/Cloud provider credentials.
4.  **Isolate Networks**: Deploy the Vector Store (Redis/Postgres) in a private subnet.

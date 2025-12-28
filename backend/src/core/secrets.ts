export const SENSITIVE_PATTERNS: string[] = [
    // Specific known keys
    "api_key",
    "openai_key",
    "gemini_key",
    "aws_secret",
    "valkey_password",
    "om_api_key",
    "openai_api_key",
    "gemini_api_key",
    "om_valkey_password",
    "om_weaviate_api_key",
    // Generic sensitive patterns (case-insensitive matching)
    "password",
    "secret",
    "token",
    "jwt",
    "access_key",
    "secret_key",
    "private_key",
    "refresh_token",
    "client_secret",
];

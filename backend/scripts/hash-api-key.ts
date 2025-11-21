#!/usr/bin/env bun

/**
 * Hash an API key using Bun.password.hash (argon2id by default).
 *
 * Usage:
 *   bun run backend/scripts/hash-api-key.ts <plaintext-key>
 *   or set OM_PLAIN_API_KEY env var and run without args.
 *
 * This script prints the hashed API key to stdout. Do NOT commit the plaintext key.
 *
 * Example:
 *   export OM_PLAIN_API_KEY="my-secret"
 *   bun run backend/scripts/hash-api-key.ts
 */

const key =
    process.argv[2] ||
    process.env.OM_PLAIN_API_KEY ||
    process.env.OPENMEMORY_API_KEY ||
    process.env.OM_API_KEY;

if (!key) {
    console.error(
        "Usage: bun run backend/scripts/hash-api-key.ts <plaintext-key>\nOr set OM_PLAIN_API_KEY env var.",
    );
    process.exit(1);
}

try {
    // Bun has a global `Bun` object which provides secure hashing helpers.
    // Use the stable async hash API. We intentionally avoid printing the plaintext key.
    const hashed = await Bun.password.hash(key);
    console.log(hashed);
} catch (err) {
    console.error(
        "Failed to hash API key:",
        err instanceof Error ? err.message : String(err),
    );
    process.exit(2);
}

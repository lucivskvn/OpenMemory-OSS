#!/usr/bin/env bun

// Usage:
//   bun run scripts/hash-api-key.ts "my-plaintext-key"
//   or set OM_PLAIN_API_KEY env and run without args

const key = process.argv[2] || process.env.OM_PLAIN_API_KEY;
if (!key) {
    console.error("Usage: bun run scripts/hash-api-key.ts <plaintext-key>\nOr set OM_PLAIN_API_KEY env var.");
    process.exit(1);
}

try {
    // Use Bun's password hash (argon2id by default in Bun). Top-level await supported.
    const hashed = await Bun.password.hash(key);
    // Print the hashed value only (do not print the plaintext)
    console.log(hashed);
} catch (e) {
    console.error("Failed to hash API key:", e);
    process.exit(2);
}

// Usage: bun run backend/scripts/hash-api-key.ts <your-api-key>
const apiKey = process.argv[2] || process.env.OPENMEMORY_API_KEY || process.env.OM_API_KEY;

if (!apiKey) {
    console.error("Usage: bun run backend/scripts/hash-api-key.ts <your-api-key>");
    process.exit(1);
}

export { };

(async () => {
    try {
        // @ts-ignore - Bun global in runtime
        const hashedKey = await Bun.password.hash(apiKey);
        console.log(hashedKey);
    } catch (e) {
        console.error('Hashing failed:', e instanceof Error ? e.message : String(e));
        process.exit(2);
    }
})();

#!/usr/bin/env bun

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

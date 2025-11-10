// backend/scripts/hash-api-key.ts
// Usage: bun run backend/scripts/hash-api-key.ts <your-api-key>

const apiKey = process.argv[2];

if (!apiKey) {
    console.error("❌ Please provide an API key to hash.");
    console.log("Usage: bun run backend/scripts/hash-api-key.ts <your-api-key>");
    process.exit(1);
}

// Hash the API key using the default Argon2id algorithm
const hashedKey = await Bun.password.hash(apiKey);

console.log("✅ Your hashed API key is:");
console.log(hashedKey);
console.log("\nCopy this value and set it as your OM_API_KEY in your .env file.");

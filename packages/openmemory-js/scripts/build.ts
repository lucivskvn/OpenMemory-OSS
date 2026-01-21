/// <reference types="bun-types" />
/**
 * Cross-platform build script for OpenMemory JS SDK.
 * Uses Bun native APIs for multi-OS compatibility.
 */

// List of entry points
const entrypoints = [
    "./src/server/start.ts",
    "./src/index.ts",
    "./src/ai/mcp.ts",
    "./src/ai/graph.ts",
    "./src/client.ts",
    "./src/cli.ts"
];

// External dependencies - exclude heavy libs or those with native bindings
const externals = [
    "@huggingface/transformers",
    "onnxruntime-node",
    "@modelcontextprotocol/sdk",
    "@aws-sdk/client-bedrock-runtime",
    "@aws-sdk/core",
    "@anthropic-ai/sdk",
    "@azure/msal-node",
    "@notionhq/client",
    "@octokit/rest",
    "openai",
    "googleapis",
    "pg",
    "ioredis",
    "pdf-parse",
    "mammoth",
    "cheerio",
    "fluent-ffmpeg",
    "zod", // Usually better to share zod instance if possible, but external safeguards versions
];

try {
    // Single pass build for generic target
    const result = await Bun.build({
        entrypoints: entrypoints,
        outdir: "./dist",
        target: "bun",
        external: externals,
        splitting: false,
        minify: true, // Switched to true for Bun 1.3.6 performance boost
        sourcemap: "external",
        // @ts-ignore - metafile is available in Bun 1.3.6+
        metafile: true,
    });

    if (!result.success) {
        console.error("❌ Build failed");
        for (const message of result.logs) {
            console.error(message);
        }
        process.exit(1);
    }
    console.log("✅ Bundle complete");

    // @ts-ignore - Analyze metafile if successful
    if (result.metafile) {
        console.log("📊 Bundle Analysis (Bun 1.3.6):");
        // @ts-ignore
        for (const [path, info] of Object.entries(result.metafile.outputs)) {
            // @ts-ignore
            console.log(`  - ${path}: ${(info.bytes / 1024).toFixed(2)} KB`);
        }
    }

    console.log("📝 Generating type declarations...");
    // Bun Native DTS generation (experimental but preferred for pure Bun)
    // We use `tsc` via Bun if highly complex types, but let's try to stick to native if user wants "Native Bun Tooling".
    // However, `Bun.build` with `dts: true` is not yet fully capable of multi-entry complex projects in all versions.
    // Let's rely on `bun build --dts` CLI equivalent or tsc. 
    // Given "avoid Nodejs as much possible", we run tsc via bun.

    const dtsProc = Bun.spawn([
        "bun",
        "./node_modules/typescript/bin/tsc",
        "--emitDeclarationOnly",
        "--declaration",
        "--outDir", "./dist",
        "--project", "tsconfig.build.json"
    ], {
        cwd: import.meta.dir + "/..",
        stdout: "inherit",
        stderr: "inherit",
    });

    const dtsExit = await dtsProc.exited;
    if (dtsExit !== 0) {
        console.error("❌ Type declaration generation failed");
        process.exit(1);
    }
    console.log("✅ Types generated");

} catch (e) {
    console.error("Build Error:", e);
    process.exit(1);
}

console.log("🎉 Build Check Complete");

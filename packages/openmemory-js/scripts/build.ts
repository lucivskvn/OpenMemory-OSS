/// <reference types="bun-types" />
/**
 * Cross-platform build script for OpenMemory JS SDK.
 * Uses Bun native APIs for multi-OS compatibility.
 */

async function build() {
    console.log("📦 Building OpenMemory JS SDK...\n");

    // External packages that have bundling issues or are better as runtime deps
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
    ];

    const bundleProc = Bun.spawn([
        "bun", "build",
        "./src/server/start.ts", "./src/index.ts", "./src/ai/mcp.ts",
        "./src/ai/graph.ts", "./src/client.ts", "./src/cli.ts",
        "--outdir", "./dist", "--target", "bun",
        ...externals.flatMap(ext => ["--external", ext])
    ], { cwd: import.meta.dir + "/.." });

    const bundleExitCode = await bundleProc.exited;
    if (bundleExitCode !== 0) {
        console.error("❌ Bundle step failed");
        process.exit(1);
    }
    console.log("✅ Bundle complete\n");

    // Generate type declarations using tsc (more reliable than Bun DTS for complex projects)
    console.log("📝 Generating type declarations with tsc...");
    const tscProc = Bun.spawn(["bun", "x", "tsc", "-p", "tsconfig.build.json"], {
        cwd: import.meta.dir + "/..",
        stdout: "inherit",
        stderr: "inherit"
    });

    const tscExitCode = await tscProc.exited;
    if (tscExitCode !== 0) {
        console.error("❌ Type generation failed");
        process.exit(1);
    }
    console.log("✅ Type declarations generated\n");

    console.log("🎉 Build complete!");
}

build().catch((err) => {
    console.error("❌ Build failed:", err);
    process.exit(1);
});

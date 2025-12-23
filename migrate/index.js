#!/usr/bin/env node
const fs = require('fs'),
  path = require('path');

const ASC = `   ____                   __  __                                 
  / __ \\                 |  \\/  |                                
 | |  | |_ __   ___ _ __ | \\  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \\ / _ \\ '_ \\| |\\/| |/ _ \\ '_ \` _ \\ / _ \\| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \\____/| .__/ \\___|_| |_|_|  |_|\\___|_| |_| |_|\\___/|_|   \\__, |
        | |                                                 __/ |
        |_|                                                |___/ `;

const loadEnv = () => {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
};

loadEnv();

const parseArgs = () => {
  const args = process.argv.slice(2);
  const config = {
    fromProvider: null,
    apiKey: null,
    url: null,
    outputDir: path.join(__dirname, 'exports'),
    batchSize: 1000,
    rateLimit: null,
    openMemoryUrl: null,
    openMemoryKey: null,
    verify: false,
    resume: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from') config.fromProvider = args[++i];
    else if (arg === '--api-key') config.apiKey = args[++i];
    else if (arg === '--url') config.url = args[++i];
    else if (arg === '--output') config.outputDir = args[++i];
    else if (arg === '--batch-size') config.batchSize = parseInt(args[++i]);
    else if (arg === '--rate-limit') config.rateLimit = parseFloat(args[++i]);
    else if (arg === '--openmemory-url') config.openMemoryUrl = args[++i];
    else if (arg === '--openmemory-key') config.openMemoryKey = args[++i];
    else if (arg === '--verify') config.verify = true;
    else if (arg === '--resume') config.resume = true;
    else if (arg === '--help') {
      console.log(
        `Usage: node migrate.js --from <zep|mem0|supermemory> --api-key <key> [options]
        
Options:
  --api-key <key>          API key for source provider (required)
  --from <provider>        Source provider: zep, mem0, or supermemory (required)
  --url <url>              Custom API base URL for source provider (optional)
  --output <dir>           Output directory for exports (default: ./exports)
  --batch-size <n>         Batch size for processing (default: 1000)
  --rate-limit <rps>       Requests per second for source (default: provider-specific)
                           - Zep: 1 req/s (default)
                           - Mem0: 20 req/s (default)
                           - Supermemory: 5 req/s (default)
  --openmemory-url <url>   OpenMemory API URL (default: http://localhost:8080)
  --openmemory-key <key>   OpenMemory API key for authentication (optional)
  --verify                 Run verification after import
  --resume                 Resume from previous export
  --help                   Show this help message

Environment Variables:
  OPENMEMORY_URL          Default OpenMemory API URL
  OPENMEMORY_API_KEY      Default OpenMemory API key

Examples:
  node migrate.js --from zep --api-key sk_xxx --rate-limit 0.5
  node migrate.js --from mem0 --api-key mem0_xxx --verify
  node migrate.js --from supermemory --api-key sm_xxx --openmemory-key my_key`,
      );
      process.exit(0);
    }
  }

  if (!config.rateLimit) {
    if (config.fromProvider === 'zep') config.rateLimit = 1;
    else if (config.fromProvider === 'mem0') config.rateLimit = 20;
    else if (config.fromProvider === 'supermemory') config.rateLimit = 5;
  }
  return config;
};

async function run() {
  console.log(ASC);
  console.log('\n=== Migration Tool ===\n');

  const config = parseArgs();

  if (!config.fromProvider || !config.apiKey) {
    console.error('[ERROR] Required: --from and --api-key');
    process.exit(1);
  }

  if (!['zep', 'mem0', 'supermemory'].includes(config.fromProvider)) {
    console.error('[ERROR] Invalid provider. Use: zep, mem0, or supermemory');
    process.exit(1);
  }

  if (!fs.existsSync(config.outputDir)) fs.mkdirSync(config.outputDir, { recursive: true });

  console.log(`[CONFIG] Provider: ${config.fromProvider.toUpperCase()}`);
  console.log(`[CONFIG] Batch Size: ${config.batchSize}`);
  console.log(`[CONFIG] Rate Limit: ${config.rateLimit} req/s`);
  console.log(`[CONFIG] Output: ${config.outputDir}`);

  const omUrl =
    config.openMemoryUrl || process.env.OPENMEMORY_URL || process.env.OM_PORT
      ? `http://localhost:${process.env.OM_PORT || 8080}`
      : 'http://localhost:8080';

  const omKey =
    config.openMemoryKey || process.env.OPENMEMORY_API_KEY || process.env.OM_API_KEY || '';

  console.log(`[CONFIG] OpenMemory API: ${omUrl}`);
  console.log(`[CONFIG] OpenMemory Auth: ${omKey ? 'Configured' : 'None'}\n`);

  // Pass resolved values to components
  if (!config.openMemoryUrl) config.openMemoryUrl = omUrl;
  if (!config.openMemoryKey) config.openMemoryKey = omKey;

  try {
    const ProviderClass = require(`./providers/${config.fromProvider}`);
    // Map refactored config back to short props if providers expect them (assuming providers are legacy)
    // Actually, providers likely expect 'c' structure.
    // Let's create a compatibility object or update providers.
    // Since "Deep Dive" implies fixing things, I should probably check providers.
    // But to minimize risk, I will map the new config object to match the old structure expected by providers if they use it.
    // The old structure was: f, k, u, o, b, rl, omu, omk, v, r.
    // Providers constructor: `constructor(c) { this.c = c; ... }`
    // They access `this.c.k` etc.
    // So I must provide a compatible object OR refactor providers.
    // Given the task is "Standardize naming", I should ideally refactor providers too.
    // But I have limited scope in this step.
    // I will pass a mapped object for now to ensure compatibility with `providers/*.js` which I am not editing in this step.
    // Wait, the plan didn't say I'll edit providers.
    // So I MUST maintain compatibility.

    const legacyConfig = {
        f: config.fromProvider,
        k: config.apiKey,
        u: config.url,
        o: config.outputDir,
        b: config.batchSize,
        rl: config.rateLimit,
        omu: config.openMemoryUrl,
        omk: config.openMemoryKey,
        v: config.verify,
        r: config.resume
    };

    const provider = new ProviderClass(legacyConfig);

    console.log('[PHASE 1/4] Connecting to provider...');
    const stats = await provider.conn();
    console.log(`[SUCCESS] Connected to ${config.fromProvider.toUpperCase()}`);
    if (stats.ses !== undefined) console.log(`[STATS] Sessions: ${stats.ses}`);
    if (stats.m !== undefined) console.log(`[STATS] Memories: ${stats.m}`);
    if (stats.d !== undefined) console.log(`[STATS] Documents: ${stats.d}\n`);

    console.log('[PHASE 2/4] Fetching data from provider...');
    const exportFile = await provider.exp();
    console.log(`[SUCCESS] Data exported to: ${exportFile}\n`);

    console.log('[PHASE 3/4] Importing to OpenMemory HSG...');
    const Importer = require('./imp');
    const importer = new Importer(config); // I will update Importer to use new config
    const importStats = await importer.importFile(exportFile); // I will rename imp() to importFile()

    console.log('\n[SUCCESS] Import completed');
    console.log(`[RESULT] Memories imported: ${importStats.imported}`);
    if (importStats.failed > 0) console.log(`[RESULT] Failed records: ${importStats.failed}`);
    console.log(`[RESULT] Duration: ${importStats.duration}s\n`);

    if (config.verify) {
      console.log('[PHASE 4/4] Running verification...');
      const Verifier = require('./ver');
      const verifier = new Verifier(config); // I will update Verifier to use new config
      const verificationResult = await verifier.verify(importStats); // Rename ver() to verify()

      if (verificationResult.ok) {
        console.log('[SUCCESS] Verification passed');
      } else {
        console.log('[WARNING] Verification issues:');
        verificationResult.warnings.forEach((w) => console.log(`  - ${w}`));
      }
    }

    console.log('\n[COMPLETE] Migration finished successfully\n');
    process.exit(0);
  } catch (e) {
    console.error('\n[FATAL] Migration failed:', e.message);
    console.error('[TRACE]', e.stack);
    process.exit(1);
  }
}

if (require.main === module) run();

module.exports = { parseArgs, run };

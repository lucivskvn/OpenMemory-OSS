#!/usr/bin/env bun
// Postinstall is best-effort: some build artifacts may not exist when installing
// from source. Require compiled modules defensively so `bun install` or `npm
// install` won't fail during local development.
let detectBackend;
let writeMCPConfig;
let writeCursorConfig;
let writeClaudeConfig;
let writeWindsurfConfig;
let writeCopilotConfig;
let writeCodexConfig;

try {
  detectBackend = require('./out/detectors/openmemory').detectBackend;
} catch (e) {
  // fallback stub: assume backend is not present
  detectBackend = async () => false;
}

try {
  writeMCPConfig = require('./out/mcp/generator').writeMCPConfig;
} catch (e) {
  writeMCPConfig = async () => { throw new Error('mcp generator not built'); };
}

try {
  writeCursorConfig = require('./out/writers/cursor').writeCursorConfig;
} catch (e) {
  writeCursorConfig = async () => { throw new Error('cursor writer not built'); };
}

try {
  writeClaudeConfig = require('./out/writers/claude').writeClaudeConfig;
} catch (e) {
  writeClaudeConfig = async () => { throw new Error('claude writer not built'); };
}

try {
  writeWindsurfConfig = require('./out/writers/windsurf').writeWindsurfConfig;
} catch (e) {
  writeWindsurfConfig = async () => { throw new Error('windsurf writer not built'); };
}

try {
  writeCopilotConfig = require('./out/writers/copilot').writeCopilotConfig;
} catch (e) {
  writeCopilotConfig = async () => { throw new Error('copilot writer not built'); };
}

try {
  writeCodexConfig = require('./out/writers/codex').writeCodexConfig;
} catch (e) {
  writeCodexConfig = async () => { throw new Error('codex writer not built'); };
}

const DEFAULT_URL = 'http://localhost:8080';

async function postInstall() {
  console.log('🧠 OpenMemory IDE Extension - Auto-Setup');
  console.log('=========================================\n');

  console.log('Checking for OpenMemory backend...');
  const isRunning = await detectBackend(DEFAULT_URL);

  if (isRunning) {
    console.log('✅ Backend detected at', DEFAULT_URL);
    console.log('\nAuto-linking AI tools...');

    try {
      const mcpPath = await writeMCPConfig(DEFAULT_URL);
      console.log(`  ✓ MCP config: ${mcpPath}`);

      const cursorPath = await writeCursorConfig(DEFAULT_URL);
      console.log(`  ✓ Cursor config: ${cursorPath}`);

      const claudePath = await writeClaudeConfig(DEFAULT_URL);
      console.log(`  ✓ Claude config: ${claudePath}`);

      const windsurfPath = await writeWindsurfConfig(DEFAULT_URL);
      console.log(`  ✓ Windsurf config: ${windsurfPath}`);

      const copilotPath = await writeCopilotConfig(DEFAULT_URL);
      console.log(`  ✓ GitHub Copilot config: ${copilotPath}`);

      const codexPath = await writeCodexConfig(DEFAULT_URL);
      console.log(`  ✓ Codex config: ${codexPath}`);
      console.log(
        '\n🎉 Setup complete! All AI tools can now access OpenMemory.',
      );
      console.log('\nSupported AI tools:');
      console.log('  • GitHub Copilot');
      console.log('  • Cursor');
      console.log('  • Claude');
      console.log('  • Windsurf');
      console.log('  • Codex');
      console.log('  • Any MCP-compatible AI');
      console.log('\nRestart your AI tools to activate.');
    } catch (error) {
      console.error('\n❌ Auto-link failed:', error.message);
      console.log('\nYou can manually configure later via the extension.');
    }
  } else {
    console.log('⚠️  Backend not detected at', DEFAULT_URL);
    console.log('\nTo start the backend:');
    console.log('  cd backend && bun run start');
    console.log(
      '\nAuto-link will run automatically when you activate the extension.',
    );
  }

  console.log('\n📖 For more info: https://github.com/CaviraOSS/OpenMemory');
}

postInstall().catch(console.error);

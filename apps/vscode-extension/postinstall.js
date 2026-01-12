const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'out');
const DEFAULT_URL = 'http://localhost:8080';

async function main() {
  if (!fs.existsSync(outDir)) {
    console.log('Postinstall: ./out directory not found. Skipping auto-setup. (Please run compile first)');
    process.exit(0);
  }

  try {
    const { detectBackend } = require('./out/detectors/openmemory');
    const { writeAntigravityConfig } = require('./out/writers/antigravity');
    const { writeCursorConfig } = require('./out/writers/cursor');
    const { writeClaudeConfig } = require('./out/writers/claude');
    const { writeWindsurfConfig } = require('./out/writers/windsurf');
    const { writeCopilotConfig } = require('./out/writers/copilot');
    const { writeCodexConfig } = require('./out/writers/codex');

    await postInstall(detectBackend, writeAntigravityConfig, writeCursorConfig, writeClaudeConfig, writeWindsurfConfig, writeCopilotConfig, writeCodexConfig);
  } catch (e) {
    console.log('Postinstall: Failed to load modules. Skipping.', e.message);
  }
}

async function postInstall(detectBackend, writeAntigravityConfig, writeCursorConfig, writeClaudeConfig, writeWindsurfConfig, writeCopilotConfig, writeCodexConfig) {
  console.log('🧠 OpenMemory IDE Extension - Auto-Setup');
  console.log('=========================================\n');

  console.log('Checking for OpenMemory backend...');
  const isRunning = await detectBackend(DEFAULT_URL);

  if (isRunning) {
    console.log('✅ Backend detected at', DEFAULT_URL);
    console.log('\nAuto-linking AI tools...');

    try {
      const antigravityPath = await writeAntigravityConfig(DEFAULT_URL, undefined, true);
      console.log(`  ✓ Antigravity config (MCP): ${antigravityPath}`);

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
    console.log('  cd backend && npm start');
    console.log(
      '\nAuto-link will run automatically when you activate the extension.',
    );
  }

  console.log('\n📖 For more info: https://github.com/CaviraOSS/OpenMemory');
}

main().catch(console.error);

const { spawn } = require('child_process');
const path = require('path');

console.log('🧠 OpenMemory Backend Example');
console.log('=============================');

const backendPath = path.join(__dirname, '..', '..', 'backend');
process.chdir(backendPath);

console.log('Starting OpenMemory server...');

// Prefer Bun when available (Bun is the recommended runtime); fall back to
// npm for environments that still rely on Node tooling.
const useBun = (() => {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('bun', ['--version'], { stdio: 'ignore', shell: true });
    return r.status === 0;
  } catch (e) {
    return false;
  }
})();

const server = spawn(
  useBun ? 'bun' : 'npm',
  useBun ? ['run', 'start'] : ['start'],
  {
    stdio: 'inherit',
    shell: true,
  },
);

server.on('close', (code) => {
  console.log(`Server exited with code ${code}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.kill('SIGINT');
  process.exit(0);
});

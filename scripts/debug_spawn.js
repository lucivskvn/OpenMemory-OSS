let spawnFn = null
try {
    // Prefer Bun.spawn when available (matches test harness behavior)
    if (globalThis.Bun && typeof globalThis.Bun.spawn === 'function') {
        spawnFn = (...a) => globalThis.Bun.spawn(...a)
    }
} catch (e) { }
if (!spawnFn) {
    const { spawn } = require('child_process')
    spawnFn = (...a) => spawn(...a)
}
const fs = require('fs');

const out = fs.createWriteStream('/tmp/debug_server_out.log', { flags: 'a' });
const err = fs.createWriteStream('/tmp/debug_server_err.log', { flags: 'a' });

console.log('Spawning server: bun run start (cwd=backend)');
let child = null
if (globalThis.Bun && typeof globalThis.Bun.spawn === 'function') {
    // Use the same signature as the test harness: spawn(['bun','run','start'], opts)
    child = spawnFn(['bun', 'run', 'start'], { cwd: 'backend', env: Object.assign({}, process.env, { OM_API_KEY: 'your', OM_EMBED_KIND: 'local', OM_DB_PATH: ':memory:' }), stdout: 'pipe', stderr: 'pipe' })
    // Bun.spawn returns a process object with stdout/stderr as ReadableStreams
    const readerOut = child.stdout.getReader()
    const readerErr = child.stderr.getReader()
    const textDecoder = new TextDecoder()
        ; (async () => {
            while (true) {
                const { value, done } = await readerOut.read()
                if (done) break
                fs.appendFileSync('/tmp/debug_server_out.log', textDecoder.decode(value))
            }
        })()
        ; (async () => {
            while (true) {
                const { value, done } = await readerErr.read()
                if (done) break
                fs.appendFileSync('/tmp/debug_server_err.log', textDecoder.decode(value))
            }
        })()
    child.onExit.then(({ code, signal }) => console.log('child exit', code, signal))
} else {
    child = spawnFn('bun', ['run', 'start'], {
        cwd: 'backend',
        env: Object.assign({}, process.env, {
            OM_API_KEY: 'your',
            OM_EMBED_KIND: 'local',
            OM_DB_PATH: ':memory:'
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.on('exit', (code, sig) => {
        console.log('child exit', code, sig);
    });
}

(async function waitForHealth() {
    const url = 'http://localhost:8080/health';
    const max = 60; // checks
    for (let i = 0; i < max; i++) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                console.log('Server healthy');
                const body = await res.text();
                console.log('Body len', body.length);
                return process.exit(0);
            }
        } catch (e) {
            // ignore
        }
        await new Promise(r => setTimeout(r, 200));
    }
    console.error('Server did not become healthy in time; check logs');
    console.error('--- /tmp/debug_server_out.log ---');
    console.error(fs.readFileSync('/tmp/debug_server_out.log', 'utf8'));
    console.error('--- /tmp/debug_server_err.log ---');
    console.error(fs.readFileSync('/tmp/debug_server_err.log', 'utf8'));
    process.exit(1);
})();

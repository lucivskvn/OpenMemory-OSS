// Helper to ensure the backend server is running (in-process singleton).
module.exports = async function ensureServer() {
    // If server already started, return early
    if (globalThis.__OM_TEST_SERVER) return globalThis.__OM_TEST_SERVER

    // Ensure environment defaults needed for server
    process.env.OM_API_KEY = process.env.OM_API_KEY || 'your'
    process.env.OM_EMBED_KIND = process.env.OM_EMBED_KIND || 'local'
    process.env.OM_DB_PATH = process.env.OM_DB_PATH || ':memory:'
    // mark test mode so background jobs are disabled
    process.env.OM_TESTING = '1'

    // Start server using the backend startServer helper
    const { startServer } = require('../../backend/src/server/index.ts')
    const { stop_coact_timer } = require('../../backend/src/memory/hsg')
    const handle = await startServer()

    // Wrap the release() function so we additionally ensure any hsg timers
    // are stopped even if a caller forgets. stop_coact_timer is idempotent.
    if (handle && typeof handle.release === 'function') {
        const _origRelease = handle.release.bind(handle)
        handle.release = async () => {
            try {
                await _origRelease()
            } finally {
                try { stop_coact_timer() } catch (e) { }
            }
        }
    }

    // Wait for /health to respond
    const BASE = 'http://localhost:8080'
    const max = 30
    for (let i = 0; i < max; i++) {
        try {
            const r = await fetch(`${BASE}/health`)
            if (r.ok) return handle
        } catch (e) {
            // ignore
        }
        await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('Server did not become ready in time')
}

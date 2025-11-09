const server = require('./server.js')
import { env, tier } from '../core/cfg'
import { run_decay_process, prune_weak_waypoints, stop_coact_timer } from '../memory/hsg'
import { mcp } from '../ai/mcp'
import { routes } from './routes'
import { authenticate_api_request, log_authenticated_request } from './middleware/auth'
import { start_reflection } from '../memory/reflect'
import { start_user_summary_reflection } from '../memory/user_summary'
import { req_tracker_mw } from './routes/dashboard'

const ASC = `   ____                   __  __                                 
  / __ \\                 |  \\/  |                                
 | |  | |_ __   ___ _ __ | \\  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \\ / _ \\ '_ \\| |\\/| |/ _ \\ '_ \` _ \\ / _ \\| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \\____/| .__/ \\___|_| |_|_|  |_|\\___|_| |_| |_|\\___/|_|   \\__, |
        | |                                                 __/ |
        |_|                                                |___/ `

export function createApp() {
    const app = server({ max_payload_size: env.max_payload_size })

    console.log(ASC)
    console.log(`[SERVER] Mode: ${env.mode}, Tier: ${tier}`)
    console.log(`[SERVER] Database: ${env.metadata_backend}, Vector: ${env.vector_backend}`)
    console.log(`[SERVER] Embeddings: ${env.emb_kind}, Dim: ${env.vec_dim}`)

    app.use(req_tracker_mw())

    app.use((req: any, res: any, next: any) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key')
        if (req.method === 'OPTIONS') {
            res.status(200).end()
            return
        }
        next()
    })
    // Server-level visibility for CORS configuration
    console.log(`[SERVER] CORS configured - Access-Control-Allow-Origin: *; Allowed IDE origins: ${env.ide_allowed_origins.join(',')}`)

    app.use(authenticate_api_request)
    // Log auth/rate-limit state for server visibility
    console.log(`[SERVER] Auth configured - api_key=${!!env.api_key}, rate_limit_enabled=${env.rate_limit_enabled}, rate_limit_window_ms=${env.rate_limit_window_ms}, rate_limit_max_requests=${env.rate_limit_max_requests}`)

    if (process.env.OM_LOG_AUTH === 'true') {
        app.use(log_authenticated_request)
    }

    routes(app)
    console.log('[SERVER] ROUTES: Registered routes')

    mcp(app)
    if (env.mode === 'langgraph') {
        console.log('[SERVER] MODE: LangGraph integration enabled')
    }

    return app
}

export async function startServer() {
    // If running inside tests, reuse a global server instance so multiple test files
    // don't try to bind the same port concurrently.
    if ((globalThis as any).__OM_TEST_SERVER) {
        // increment reference count and return the shared handle
        try {
            const g = (globalThis as any).__OM_TEST_SERVER
            g.refCount = (g.refCount || 1) + 1
            // return the public handle object
            return g.handle || g
        } catch (e) {
            return (globalThis as any).__OM_TEST_SERVER
        }
    }

    const app = createApp()

    // In test mode we avoid running background jobs which can cause nested
    // transactions and interfere with in-process testing (set OM_TESTING=1)
    const isTestMode = process.env.OM_TESTING === '1'

    // In test mode, attach helpful global handlers to surface unexpected
    // unhandled rejections / exceptions to the test output so we can trace
    // teardown/connectivity races more easily.
    if (isTestMode && !(globalThis as any).__OM_TEST_HANDLERS) {
        (globalThis as any).__OM_TEST_HANDLERS = true
        process.on('unhandledRejection', (reason) => {
            try { console.error('[SERVER] TEST-HOOK: unhandledRejection:', reason) } catch (e) { }
        })
        process.on('uncaughtException', (err) => {
            try { console.error('[SERVER] TEST-HOOK: uncaughtException:', err) } catch (e) { }
        })
    }

    // In test mode, wrap global fetch to log failures and stacks so we can
    // identify any late requests that happen after the server is stopped.
    if (isTestMode && !(globalThis as any).__OM_FETCH_WRAPPED) {
        (globalThis as any).__OM_FETCH_WRAPPED = true
        try {
            const origFetch = (globalThis as any).fetch
            if (origFetch) {
                (globalThis as any).fetch = async (...args: any[]) => {
                    // Capture caller stack at point of invocation
                    const callerStack = new Error().stack
                    try {
                        return await origFetch.apply(globalThis, args)
                    } catch (err) {
                        try {
                            console.error('[SERVER] TEST-HOOK: fetch failed:', err, '\ncaller stack:', callerStack)
                        } catch (e) { }
                        throw err
                    }
                }
            }
        } catch (e) { /* best-effort */ }
    }

    const decayIntervalMs = env.decay_interval_minutes * 60 * 1000
    console.log(`[SERVER] DECAY: Interval: ${env.decay_interval_minutes} minutes (${decayIntervalMs / 1000}s)`)

    let decayTimer: any = null
    let pruneTimer: any = null
    if (!isTestMode) {
        decayTimer = setInterval(async () => {
            console.log('[SERVER] DECAY: Running HSG decay process...')
            try {
                const result = await run_decay_process()
                console.log(`[SERVER] DECAY: Completed: ${result.decayed}/${result.processed} memories updated`)
            } catch (error) {
                console.error('[SERVER] DECAY: Process failed:', error)
            }
        }, decayIntervalMs)

        pruneTimer = setInterval(async () => {
            console.log('[SERVER] PRUNE: Pruning weak waypoints...')
            try {
                const pruned = await prune_weak_waypoints()
                console.log(`[SERVER] PRUNE: Completed: ${pruned} waypoints removed`)
            } catch (error) {
                console.error('[SERVER] PRUNE: Failed:', error)
            }
        }, 7 * 24 * 60 * 60 * 1000)

        run_decay_process()
            .then((result: any) => {
                console.log(`[SERVER] INIT: Initial decay: ${result.decayed}/${result.processed} memories updated`)
            })
            .catch((err) => { console.error('[SERVER] INIT: Initial decay failed:', err) })

        start_reflection()
        start_user_summary_reflection()
    } else {
        console.log('[SERVER] TEST MODE: Skipping background decay/prune/reflection tasks')
    }

    console.log(`[SERVER] Starting on port ${env.port}`)
    const srv = app.listen(env.port, () => {
        console.log(`[SERVER] Running on http://localhost:${env.port}`)
    })

    // create a stop function which actually closes the server and clears global
    const internalStop = async () => {
        return new Promise<void>((resolve) => {
            try {
                if (srv && typeof srv.close === 'function') {
                    try {
                        srv.close(() => {
                            try { clearInterval(decayTimer); clearInterval(pruneTimer); } catch (e) { }
                            try { stop_coact_timer() } catch (e) { }
                            try { delete (globalThis as any).__OM_TEST_SERVER } catch (e) { }
                            resolve()
                        })
                    } catch (e) {
                        try { srv.close(); } catch (e) { }
                        try { clearInterval(decayTimer); clearInterval(pruneTimer); } catch (e) { }
                        try { delete (globalThis as any).__OM_TEST_SERVER } catch (e) { }
                        resolve()
                    }
                } else {
                    try { clearInterval(decayTimer); clearInterval(pruneTimer); } catch (e) { }
                    try { delete (globalThis as any).__OM_TEST_SERVER } catch (e) { }
                    resolve()
                }
            } catch (e) {
                try { clearInterval(decayTimer); clearInterval(pruneTimer); } catch (e) { }
                try { delete (globalThis as any).__OM_TEST_SERVER } catch (e) { }
                resolve()
            }
        })
    }

    // return control so caller (tests) can stop things if needed
    const handle: any = {
        app,
        srv,
        // deprecated: stop immediately (force stop)
        stop: async () => {
            return internalStop()
        },
        // preferred: release a single reference to the shared test server
        release: async () => {
            try {
                const g = (globalThis as any).__OM_TEST_SERVER
                if (!g) return
                g.refCount = Math.max(0, (g.refCount || 1) - 1)
                if (g.refCount === 0) {
                    await internalStop()
                }
            } catch (e) {
                try { await internalStop() } catch (e) { }
            }
        }
    }

    // store handle with refCount so multiple callers can acquire/release safely
    const globalHolder: any = {
        handle,
        refCount: 1
    }
    try { globalHolder.handle.owner = true } catch (e) { }
    ; (globalThis as any).__OM_TEST_SERVER = globalHolder
    return handle
}

// If this module is executed directly (not required), start the server automatically
if (require && require.main === module) {
    startServer()
}

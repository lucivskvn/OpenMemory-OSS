import { beforeAll, afterAll, test, expect } from 'bun:test'
const __ensure_mod = await import('./_ensure_server.js')
const ensureServer = __ensure_mod.default || __ensure_mod
let handle, q, withTransaction, get_async, run_async

beforeAll(async () => {
    handle = await ensureServer()
    const mod = await import('../../backend/src/core/db.ts')
    q = mod.q
    withTransaction = mod.withTransaction
    get_async = mod.get_async
    run_async = mod.run_async
})
afterAll(async () => {
    if (handle && typeof handle.release === 'function') await handle.release()
})

test('withTransaction commits on success', async () => {
    await withTransaction(async () => {
        await q.ins_stat.run('wt-success', 1, Date.now())
    })
    const res = await get_async('select count(*) as c from stats where type=?', ['wt-success'])
    expect(res.c).toBe(1)
})

test('withTransaction rolls back on throw', async () => {
    try {
        await withTransaction(async () => {
            await q.ins_stat.run('wt-rollback', 1, Date.now())
            throw new Error('boom')
        })
    } catch (e) {
        // expected
    }
    const res = await get_async('select count(*) as c from stats where type=?', ['wt-rollback'])
    expect(res.c).toBe(0)
})

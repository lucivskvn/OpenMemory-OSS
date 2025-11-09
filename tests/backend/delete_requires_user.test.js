import { beforeAll, afterAll, test, expect } from 'bun:test'
const __ensure_mod = await import('./_ensure_server.js')
const ensureServer = __ensure_mod.default || __ensure_mod
let handle, q

beforeAll(async () => {
    handle = await ensureServer()
    const mod = await import('../../backend/src/core/db.ts')
    q = mod.q
})
afterAll(async () => {
    if (handle && typeof handle.release === 'function') await handle.release()
})

test('delete_requires_user behavior', async () => {
    // del_vec must throw when user_id is falsy
    await expect(q.del_vec.run('nonexistent', null)).rejects.toBeTruthy()

    // del_vec with explicit user_id should not throw
    await q.del_vec.run('nonexistent', 'testuser')

    // del_mem requires user_id - deleting non-existent id should be ok
    await q.del_mem.run('nonexistent', 'testuser')
    expect(true).toBe(true)
})

import { beforeAll, afterAll, test, expect } from 'bun:test'
const __ensure_mod = await import('./_ensure_server.js')
const ensureServer = __ensure_mod.default || __ensure_mod
let handle
let q
beforeAll(async () => {
    handle = await ensureServer()
    const mod = await import('../../backend/src/core/db.ts')
    q = mod.q
})
afterAll(async () => {
    if (handle && typeof handle.release === 'function') await handle.release()
})

test('get_vecs_batch returns inserted vectors for given ids and sector', async () => {
    const now = Date.now()
    const user = 'vecUser_' + now
    const sector = 'semantic'
    const id1 = 'vec1_' + now
    const id2 = 'vec2_' + now

    const v1 = [0.1, 0.2, 0.3]
    const v2 = [0.4, 0.5, 0.6]

    // insert mem rows (some code paths expect the memory to exist)
    await q.ins_mem.run(id1, user, 1, 'v1', 'sh1', sector, null, '{}', now, now, now, 0.5, 0.01, 1, null, null, null, 0)
    await q.ins_mem.run(id2, user, 1, 'v2', 'sh2', sector, null, '{}', now, now, now, 0.5, 0.01, 1, null, null, null, 0)

    // insert vectors
    await q.ins_vec.run(id1, sector, user, JSON.stringify(v1), v1.length)
    await q.ins_vec.run(id2, sector, user, JSON.stringify(v2), v2.length)

    const rows = await q.get_vecs_batch.all([id1, id2], sector, user)
    expect(rows.length).toBe(2)

    const map = new Map(rows.map(r => [r.id, JSON.parse(r.v)]))
    expect(map.get(id1)).toEqual(v1)
    expect(map.get(id2)).toEqual(v2)
})
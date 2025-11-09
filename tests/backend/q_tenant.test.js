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

test('tenant-safety: del_waypoints and prune_waypoints behavior', async () => {
    const uA = 'userA_' + Date.now()
    const uB = 'userB_' + Date.now()
    const mA = 'memA_' + Date.now() + '_a'
    const mB = 'memB_' + Date.now() + '_b'
    const now = Date.now()

    // Insert memories
    await q.ins_mem.run(mA, uA, 1, 'content A', 'shA', 'semantic', null, '{}', now, now, now, 0.5, 0.01, 1, null, null, null, 0)
    await q.ins_mem.run(mB, uB, 1, 'content B', 'shB', 'semantic', null, '{}', now, now, now, 0.5, 0.01, 1, null, null, null, 0)

    // Insert waypoints
    await q.ins_waypoint.run(mA, mB, uA, 0.4, now, now)
    await q.ins_waypoint.run(mB, mA, uB, 0.3, now, now)

    // should throw when user_id null
    let threw = false
    try { await q.del_waypoints.run(mA, mB, null) } catch (e) { threw = true }
    expect(threw).toBe(true)

    // delete only userA waypoint
    await q.del_waypoints.run(mA, mB, uA)
    const remainA = await q.get_waypoints_by_src.all(mA, uA)
    expect(remainA.length).toBe(0)
    const remainB = await q.get_waypoints_by_src.all(mB, uB)
    expect(remainB.length).toBeGreaterThan(0)

    // global delete
    await q.del_waypoints_global.run(mB, mA)
    const remainB2 = await q.get_waypoints_by_src.all(mB, uB)
    expect(remainB2.length).toBe(0)

    // prune tests
    await q.ins_waypoint.run('p1_' + now, 'p2_' + now, uA, 0.01, now, now)
    await q.ins_waypoint.run('p3_' + now, 'p4_' + now, uB, 0.02, now, now)

    threw = false
    try { await q.prune_waypoints.run(0.05, null) } catch (e) { threw = true }
    expect(threw).toBe(true)

    await q.prune_waypoints.run(0.05, uA)
    const p1 = await q.get_waypoint.get('p1_' + now, 'p2_' + now, uA)
    // sqlite may return null for missing rows; accept null or undefined
    expect(p1 == null).toBe(true)
    const p3 = await q.get_waypoint.get('p3_' + now, 'p4_' + now, uB)
    expect(p3).not.toBeUndefined()

    await q.prune_waypoints_global.run(0.05)
    const p3b = await q.get_waypoint.get('p3_' + now, 'p4_' + now, uB)
    expect(p3b == null).toBe(true)
})

test('segment scoping for get_mem_by_segment and get_segment_count', async () => {
    const now = Date.now()
    const seg = 999
    await q.ins_mem.run('sA_' + now, 'uSegA_' + now, seg, 'seg A', 'shA2', 'semantic', null, '{}', now, now, now, 0.5, 0.01, 1, null, null, null, 0)
    await q.ins_mem.run('sB_' + now, 'uSegB_' + now, seg, 'seg B', 'shB2', 'semantic', null, '{}', now, now, now, 0.5, 0.01, 1, null, null, null, 0)

    const allGlobal = await q.get_mem_by_segment.all(seg)
    expect(allGlobal.length).toBeGreaterThanOrEqual(2)

    const forA = await q.get_mem_by_segment.all(seg, 'uSegA_' + now)
    expect(forA.every(m => m.user_id === 'uSegA_' + now)).toBe(true)

    const cntA = await q.get_segment_count.get(seg, 'uSegA_' + now)
    expect(typeof cntA.c).toBe('number')
})

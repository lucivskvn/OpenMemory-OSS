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

test('per-user stats q helpers return expected results', async () => {
    const now = Date.now()
    await q.ins_stat.run('test', 1, now - 1000, 'userA')
    await q.ins_stat.run('test', 2, now - 900, 'userA')
    await q.ins_stat.run('test', 5, now - 800, 'userB')

    const globalRowCount = await q.stats_count_since.get('test', now - 2000)
    const aRowCount = await q.stats_count_since_by_user.get('test', 'userA', now - 2000)
    const bRowCount = await q.stats_count_since_by_user.get('test', 'userB', now - 2000)
    const rangeA = await q.stats_range_by_user.all('test', 'userA', now - 2000)
    const totalsA = await q.totals_since_by_user.all('userA', now - 2000)
    const totalsB = await q.totals_since_by_user.all('userB', now - 2000)

    expect(Number(globalRowCount?.total || 0)).toBe(3)
    expect(Number(aRowCount?.total || 0)).toBe(2)
    expect(Number(bRowCount?.total || 0)).toBe(1)
    expect(Array.isArray(rangeA)).toBe(true)
    expect(rangeA.length).toBe(2)

    const aTotal = (totalsA && totalsA[0] && Number(totalsA[0].total)) || 0
    const bTotal = (totalsB && totalsB[0] && Number(totalsB[0].total)) || 0
    expect(aTotal).toBe(3)
    expect(bTotal).toBe(5)
})


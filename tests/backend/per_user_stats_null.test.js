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

test('per-user stats null user_id behaves like global', async () => {
    const now = Date.now()
    await q.ins_stat.run('globaltest', 3, now - 1000, 'u1')
    await q.ins_stat.run('globaltest', 7, now - 900, 'u2')

    const globalCount = await q.stats_count_since.get('globaltest', now - 2000)
    const nullCount = await q.stats_count_since_by_user.get('globaltest', null, now - 2000)
    expect(Number(globalCount?.total || 0)).toBe(2)
    expect(Number(nullCount?.total || 0)).toBe(2)

    const totalsGlobal = await q.totals_since.all(now - 2000)
    const totalsNull = await q.totals_since_by_user.all(null, now - 2000)
    const gTotal = (totalsGlobal && totalsGlobal[0] && Number(totalsGlobal[0].total)) || 0
    const nTotal = (totalsNull && totalsNull[0] && Number(totalsNull[0].total)) || 0
    expect(gTotal).toBe(10)
    expect(nTotal).toBe(10)
})

const __ensure_mod = await import('./_ensure_server.js')
const ensureServer = __ensure_mod.default || __ensure_mod
await ensureServer()
const { q } = require('../../backend/src/core/db.ts')
const BASE = 'http://localhost:8080'

console.log('\n🧪 per-user stats q helpers test (in-process)')

async function runTest() {
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

    // Row counts
    if (Number(globalRowCount?.total || 0) !== 3) throw new Error('globalRowCount mismatch')
    if (Number(aRowCount?.total || 0) !== 2) throw new Error('userA row count mismatch')
    if (Number(bRowCount?.total || 0) !== 1) throw new Error('userB row count mismatch')
    if (!Array.isArray(rangeA) || rangeA.length !== 2) throw new Error('rangeA rows mismatch')

    // Totals (sum of `count` column)
    const aTotal = (totalsA && totalsA[0] && Number(totalsA[0].total)) || 0
    const bTotal = (totalsB && totalsB[0] && Number(totalsB[0].total)) || 0
    if (aTotal !== 3) throw new Error('userA total mismatch')
    if (bTotal !== 5) throw new Error('userB total mismatch')

    console.log('✅ per-user stats helpers returned expected results')
}

await runTest()


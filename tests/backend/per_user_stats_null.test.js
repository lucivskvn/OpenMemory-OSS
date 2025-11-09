// Ensure per-user helpers behave correctly when user_id is null (should act global)
const __ensure_mod = await import('./_ensure_server.js')
const ensureServer = __ensure_mod.default || __ensure_mod
await ensureServer()
const { q } = require('../../backend/src/core/db.ts')

console.log('\n🧪 per-user stats null user_id behavior test')

async function runTest() {
    const now = Date.now()
    // Insert rows for different users
    await q.ins_stat.run('globaltest', 3, now - 1000, 'u1')
    await q.ins_stat.run('globaltest', 7, now - 900, 'u2')

    // null user_id should return aggregated global totals
    const globalCount = await q.stats_count_since.get('globaltest', now - 2000)
    const nullCount = await q.stats_count_since_by_user.get('globaltest', null, now - 2000)
    if (Number(globalCount?.total || 0) !== 2) throw new Error('global row count mismatch')
    if (Number(nullCount?.total || 0) !== 2) throw new Error('null-scoped row count mismatch')

    const totalsGlobal = await q.totals_since.all(now - 2000)
    const totalsNull = await q.totals_since_by_user.all(null, now - 2000)
    const gTotal = (totalsGlobal && totalsGlobal[0] && Number(totalsGlobal[0].total)) || 0
    const nTotal = (totalsNull && totalsNull[0] && Number(totalsNull[0].total)) || 0
    if (gTotal !== 10) throw new Error('global total sum mismatch')
    if (nTotal !== 10) throw new Error('null total sum mismatch')

    console.log('✅ per-user null-scoping behavior OK')
}

await runTest()

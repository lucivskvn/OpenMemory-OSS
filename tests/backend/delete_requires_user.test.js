const __ensure_mod = await import('./_ensure_server.js')
const ensureServer = __ensure_mod.default || __ensure_mod
await ensureServer()
const { q } = require('../../backend/src/core/db.ts')

console.log('\n🧪 delete_requires_user test')

async function runTest() {
    // del_vec must throw when user_id is falsy
    let threw = false
    try {
        await q.del_vec.run('nonexistent', null)
    } catch (e) {
        threw = true
    }
    if (!threw) throw new Error('del_vec did not throw when user_id was null')

    // del_vec with explicit user_id should not throw
    await q.del_vec.run('nonexistent', 'testuser')

    // del_mem requires user_id - call and ensure no throw (deleting non-existent id is ok)
    await q.del_mem.run('nonexistent', 'testuser')

    console.log('✅ delete_requires_user behavior OK')
}

await runTest()

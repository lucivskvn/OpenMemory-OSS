import { beforeAll, afterAll, test, expect } from 'bun:test'
const __ensure_mod = await import('./_ensure_server.js')
const ensureServer = __ensure_mod.default || __ensure_mod
let handle, transaction, run_async, get_async, tx_info

beforeAll(async () => {
    handle = await ensureServer()
    const mod = await import('../../backend/src/core/db.ts')
    transaction = mod.transaction
    run_async = mod.run_async
    get_async = mod.get_async
    tx_info = mod.tx_info
})
afterAll(async () => {
    if (handle && typeof handle.release === 'function') await handle.release()
})

test('nested commit preserves outer and inner', async () => {
    // cleanup in case of prior runs
    await run_async('delete from stats where type in (?,?)', ['outer', 'inner']).catch(() => { })

    await transaction.begin()
    await run_async('insert into stats(type,count,ts) values(?,?,?)', ['outer', 1, Date.now()])
    await transaction.begin()
    await run_async('insert into stats(type,count,ts) values(?,?,?)', ['inner', 1, Date.now()])
    await transaction.commit() // commit inner
    await transaction.commit() // commit outer

    const outer = await get_async('select count(*) as c from stats where type=?', ['outer'])
    const inner = await get_async('select count(*) as c from stats where type=?', ['inner'])
    expect(outer.c).toBe(1)
    expect(inner.c).toBe(1)
})

test('nested rollback discards only inner', async () => {
    await run_async('delete from stats where type in (?,?)', ['outer2', 'inner2']).catch(() => { })

    await transaction.begin()
    await run_async('insert into stats(type,count,ts) values(?,?,?)', ['outer2', 1, Date.now()])
    await transaction.begin()
    await run_async('insert into stats(type,count,ts) values(?,?,?)', ['inner2', 1, Date.now()])
    await transaction.rollback() // rollback inner
    await transaction.commit() // commit outer

    const outer2 = await get_async('select count(*) as c from stats where type=?', ['outer2'])
    const inner2 = await get_async('select count(*) as c from stats where type=?', ['inner2'])
    expect(outer2.c).toBe(1)
    expect(inner2.c).toBe(0)
})

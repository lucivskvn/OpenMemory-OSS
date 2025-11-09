// Ensure we set testing env before importing DB so sqlite uses the in-memory DB
process.env.OM_TESTING = '1'
process.env.OM_DB_PATH = ':memory:'

const { transaction, run_async, get_async, tx_info } = require('../../backend/src/core/db')

describe('nested transactions (sqlite) - savepoint behavior', () => {
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
})

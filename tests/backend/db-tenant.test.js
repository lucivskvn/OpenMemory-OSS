const BASE = 'http://localhost:8080';
const API_KEY = 'your';

console.log('\n🧪 DB Tenant Isolation Test\n');

async function run() {
    // create two memories for two different users
    const r1 = await fetch(`${BASE}/memory/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ content: 'Memory for user A', user_id: 'user-A' })
    })
    const j1 = await r1.json()
    console.log('Created A:', j1.id || j1)

    const r2 = await fetch(`${BASE}/memory/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ content: 'Memory for user B', user_id: 'user-B' })
    })
    const j2 = await r2.json()
    console.log('Created B:', j2.id || j2)

    // delete all for user-A
    const d = await fetch(`${BASE}/users/user-A/memories`, { method: 'DELETE', headers: { Authorization: `Bearer ${API_KEY}` } })
    const dd = await d.json()
    console.log('Delete A result:', dd)

    // fetch lists for both users
    const ga = await fetch(`${BASE}/users/user-A/memories`, { headers: { Authorization: `Bearer ${API_KEY}` } })
    const gaj = await ga.json()
    console.log('User A memories after delete:', gaj.items?.length || 0)

    const gb = await fetch(`${BASE}/users/user-B/memories`, { headers: { Authorization: `Bearer ${API_KEY}` } })
    const gbj = await gb.json()
    console.log('User B memories after delete:', gbj.items?.length || 0)

    if ((gaj.items?.length || 0) !== 0) throw new Error('User A memories were not deleted')
    if ((gbj.items?.length || 0) === 0) throw new Error('User B memories unexpectedly deleted')

    console.log('✅ DB tenant isolation test passed')
}

run().catch(e => { console.error('Test failed:', e); process.exitCode = 1 })

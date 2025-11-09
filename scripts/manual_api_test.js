const fetch = globalThis.fetch || require('node-fetch');

const BASE = 'http://localhost:8080'
const API_KEY = 'your'

async function waitForHealth(retries = 60, delay = 200) {
    for (let i = 0; i < retries; i++) {
        try {
            const r = await fetch(`${BASE}/health`)
            if (r.ok) return true
        } catch (e) { }
        await new Promise(r => setTimeout(r, delay))
    }
    return false
}

async function run() {
    const ok = await waitForHealth()
    if (!ok) {
        console.error('Server not healthy')
        process.exit(2)
    }
    console.log('Health OK')

    // Add memory
    const content = 'This is a test memory from manual script'
    let r = await fetch(`${BASE}/memory/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ content })
    })
    console.log('/memory/add', r.status)
    const body = await r.json()
    console.log('add body keys', Object.keys(body))
    const id = body.id

    // list
    r = await fetch(`${BASE}/memory/all?l=10`, { headers: { Authorization: `Bearer ${API_KEY}` } })
    console.log('/memory/all', r.status)
    const list = await r.json()
    console.log('items length', list.items && list.items.length)

    // query
    r = await fetch(`${BASE}/memory/query`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` }, body: JSON.stringify({ query: 'test memory', k: 5 })
    })
    console.log('/memory/query', r.status)
    const qres = await r.json()
    console.log('matches length', qres.matches && qres.matches.length)

    // sectors
    r = await fetch(`${BASE}/sectors`, { headers: { Authorization: `Bearer ${API_KEY}` } })
    console.log('/sectors', r.status)
    const s = await r.json()
    console.log('sectors contains episodic?', s.sectors && s.sectors.includes('episodic'))

    // invalid id
    r = await fetch(`${BASE}/memory/invalid-id-does-not-exist`, { headers: { Authorization: `Bearer ${API_KEY}` } })
    console.log('/memory/invalid-id', r.status)

    process.exit(0)
}

run().catch(e => { console.error(e); process.exit(1) })

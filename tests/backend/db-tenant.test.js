import { beforeAll, afterAll, test, expect } from 'bun:test'
const __ensure_mod = await import('./_ensure_server.js')
const ensureServer = __ensure_mod.default || __ensure_mod
let handle
const BASE = 'http://localhost:8080'
const API_KEY = 'your'

beforeAll(async () => {
    handle = await ensureServer()
})
afterAll(async () => {
    if (handle && typeof handle.release === 'function') await handle.release()
})

test('DB tenant isolation: user-scoped delete does not affect other users', async () => {
    // create two memories for two different users
    const r1 = await fetch(`${BASE}/memory/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ content: 'Memory for user A', user_id: 'user-A' })
    })
    const j1 = await r1.json()
    const r2 = await fetch(`${BASE}/memory/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ content: 'Memory for user B', user_id: 'user-B' })
    })
    const j2 = await r2.json()

    // delete all for user-A
    const d = await fetch(`${BASE}/users/user-A/memories`, { method: 'DELETE', headers: { Authorization: `Bearer ${API_KEY}` } })
    const dd = await d.json()
    expect(dd).toBeDefined()

    // fetch lists for both users
    const ga = await fetch(`${BASE}/users/user-A/memories`, { headers: { Authorization: `Bearer ${API_KEY}` } })
    const gaj = await ga.json()
    const gb = await fetch(`${BASE}/users/user-B/memories`, { headers: { Authorization: `Bearer ${API_KEY}` } })
    const gbj = await gb.json()

    expect((gaj.items?.length || 0)).toBe(0)
    expect((gbj.items?.length || 0)).toBeGreaterThanOrEqual(1)
})

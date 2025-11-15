describe('Memory query SSE', () => {
  it('returns sse when Accept: text/event-stream', async () => {
    // Start a server programmatically like other tests. Prefer ephemeral port.
    const mod = await import('../../backend/src/server/index.ts')
    if (typeof mod.startServer === 'function') {
      await mod.startServer({ port: 0 })
    }
    const port = process.env.OM_PORT || process.env.PORT || '8080'
    const res = await fetch(`http://127.0.0.1:${port}/memory/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ query: 'test sse streaming', k: 3 }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.includes('event: memories')).toBeTruthy()
  })
})

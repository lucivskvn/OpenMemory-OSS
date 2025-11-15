import { NextRequest } from 'next/server'
import { API_BASE_URL, getHeaders, getServerHeaders } from '@/lib/api'

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') || req.nextUrl.searchParams.get('query') || ''
  const embeddingMode = req.nextUrl.searchParams.get('embedding_mode') || ''

  const resp = await fetch(`${API_BASE_URL}/memory/query`, {
    method: 'POST',
      headers: getServerHeaders(),
    body: JSON.stringify({ query: q, k: 10, metadata: { embedding_mode: embeddingMode } }),
  })
  const body = await resp.json().catch(() => ({ matches: [] }))
  const memIds = (body.matches || []).map((m:any) => m.id).filter(Boolean)

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: memories\n'))
      controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'memories', data: body.matches || [], memory_ids: memIds }) + '\n\n'))
      controller.enqueue(encoder.encode('event: done\n'))
      controller.enqueue(encoder.encode('data: {}\n\n'))
      controller.close()
    }
  })

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}

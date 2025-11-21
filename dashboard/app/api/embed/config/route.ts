import { NextRequest } from 'next/server'
import { API_BASE_URL, getServerHeaders } from '@/lib/api'

// GET /embed/config
export async function GET(req: NextRequest) {
    const params = new URLSearchParams(req.nextUrl.search)
    const detailed = params.get('detailed') === 'true'

    const url = `${API_BASE_URL}/embed/config${detailed ? '?detailed=true' : ''}`
    const res = await fetch(url, { headers: getServerHeaders() })
    const data = await res.json()
    return new Response(JSON.stringify(data), { status: res.status })
}

// POST /embed/config
export async function POST(req: NextRequest) {
    const body = await req.json()
    const url = `${API_BASE_URL}/embed/config`
    const res = await fetch(url, {
        method: 'POST',
        headers: getServerHeaders(),
        body: JSON.stringify(body),
    })
    const data = await res.json()
    return new Response(JSON.stringify(data), { status: res.status })
}

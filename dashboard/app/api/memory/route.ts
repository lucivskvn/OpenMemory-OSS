import { NextRequest } from 'next/server'
import { API_BASE_URL, getServerHeaders } from '@/lib/api'

// POST /memory/add
export async function POST(req: NextRequest) {
    const body = await req.json()
    const url = `${API_BASE_URL}/memory/add`
    const res = await fetch(url, {
        method: 'POST',
        headers: getServerHeaders(),
        body: JSON.stringify(body),
    })
    const data = await res.json()
    return new Response(JSON.stringify(data), { status: res.status })
}

import { NextRequest } from 'next/server'
import { API_BASE_URL, getServerHeaders } from '@/lib/api'

// GET /memory/all
export async function GET(req: NextRequest) {
    const params = new URLSearchParams(req.nextUrl.search)
    const limit = params.get('l') || params.get('limit') || '100'
    const offset = params.get('u') || params.get('offset') || '0'
    const sector = params.get('sector')
    const user_id = params.get('user_id')

    let url = `${API_BASE_URL}/memory/all?l=${limit}&u=${offset}`
    if (sector) url += `&sector=${encodeURIComponent(sector)}`
    if (user_id) url += `&user_id=${encodeURIComponent(user_id)}`

    const res = await fetch(url, { headers: getServerHeaders() })
    const data = await res.json()
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}

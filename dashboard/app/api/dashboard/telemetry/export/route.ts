import { NextRequest } from 'next/server'
import { API_BASE_URL, getServerHeaders } from '@/lib/api'

export async function GET(req: NextRequest) {
    const params = new URLSearchParams(req.nextUrl.search)
    const limit = params.get('limit') || '1000'  // Larger limit for export
    const offset = params.get('offset') || '0'
    const user_id = params.get('user_id') || ''
    const embedding_mode = params.get('embedding_mode') || ''

    const url = `${API_BASE_URL}/dashboard/telemetry?limit=${limit}&offset=${offset}` + (user_id ? `&user_id=${encodeURIComponent(user_id)}` : '') + (embedding_mode ? `&embedding_mode=${encodeURIComponent(embedding_mode)}` : '')
    const res = await fetch(url, { headers: getServerHeaders() })
    const data = await res.json().catch(() => ({ telemetry: [] }))

    // Set headers for download as JSON file
    return new Response(JSON.stringify(data, null, 2), {
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="telemetry-export.json"'
        }
    })
}

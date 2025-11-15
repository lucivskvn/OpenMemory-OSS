import { NextRequest } from 'next/server'
import { API_BASE_URL, getServerHeaders } from '@/lib/api'

export async function GET(req: NextRequest) {
    const params = new URLSearchParams(req.nextUrl.search)
    const url = `${API_BASE_URL}/dashboard/telemetry/export?${params.toString()}`
    const res = await fetch(url, { headers: getServerHeaders() })
    const csv = await res.text().catch(() => '')
    // Pass through CSV with appropriate headers
    return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="telemetry.csv"' } })
}

import { NextRequest } from 'next/server';
import { API_BASE_URL, getServerHeaders } from '@/lib/api';

export async function GET(req: NextRequest) {
  const params = new URLSearchParams(req.nextUrl.search);
  const limit = params.get('limit') || '50';
  const offset = params.get('offset') || '0';
  const user_id = params.get('user_id') || '';
  const embedding_mode = params.get('embedding_mode') || '';

  const url =
    `${API_BASE_URL}/dashboard?limit=${limit}&offset=${offset}` +
    (user_id ? `&user_id=${encodeURIComponent(user_id)}` : '') +
    (embedding_mode
      ? `&embedding_mode=${encodeURIComponent(embedding_mode)}`
      : '');
  const res = await fetch(url, { headers: getServerHeaders() });
  const data = await res.json().catch(() => ({ telemetry: [] }));
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const url = `${API_BASE_URL}/dashboard`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getServerHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status });
}

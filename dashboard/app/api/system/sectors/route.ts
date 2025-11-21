import { NextRequest } from 'next/server';
import { API_BASE_URL, getServerHeaders } from '@/lib/api';

// GET /system/sectors
export async function GET() {
  const url = `${API_BASE_URL}/sectors`;
  const res = await fetch(url, { headers: getServerHeaders() });
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status });
}

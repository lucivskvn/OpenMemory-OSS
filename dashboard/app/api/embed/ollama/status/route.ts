import { NextRequest } from 'next/server';
import { API_BASE_URL, getServerHeaders } from '@/lib/api';

// GET /embed/ollama/status
export async function GET() {
  const url = `${API_BASE_URL}/embed/ollama/status`;
  const res = await fetch(url, { headers: getServerHeaders() });
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status });
}

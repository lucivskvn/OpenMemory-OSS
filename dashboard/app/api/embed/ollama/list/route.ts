import { NextRequest } from 'next/server';
import { API_BASE_URL, getServerHeaders } from '@/lib/api';

// GET /embed/ollama/list
export async function GET() {
  const url = `${API_BASE_URL}/embed/ollama/list`;
  const res = await fetch(url, { headers: getServerHeaders() });
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status });
}

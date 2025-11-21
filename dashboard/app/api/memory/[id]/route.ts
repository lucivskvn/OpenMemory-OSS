import { NextRequest } from 'next/server';
import { API_BASE_URL, getServerHeaders } from '@/lib/api';

// GET /memory/:id
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = `${API_BASE_URL}/memory/${id}`;
  const res = await fetch(url, { headers: getServerHeaders() });
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status });
}

// PATCH /memory/:id
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json();
  const url = `${API_BASE_URL}/memory/${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: getServerHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status });
}

// DELETE /memory/:id
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = `${API_BASE_URL}/memory/${id}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: getServerHeaders(),
  });
  const data = await res.json();
  return new Response(JSON.stringify(data), { status: res.status });
}

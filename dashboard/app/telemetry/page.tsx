"use client"
import { useState, useEffect } from 'react'
import Sidebar from '@/components/sidebar'
import { API_BASE_URL, getHeaders } from '@/lib/api'

export default function TelemetryPage() {
    const [items, setItems] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [user, setUser] = useState('')
    const [mode, setMode] = useState('')

    useEffect(() => { fetchTelemetry(); }, [])

    const fetchTelemetry = async (u?: string, m?: string) => {
        setLoading(true)
        const params = new URLSearchParams()
        if (u) params.append('user_id', u)
        if (m) params.append('embedding_mode', m)
        params.append('limit', '50')

        const r = await fetch(`/api/dashboard/telemetry?${params.toString()}`)
        if (!r.ok) { setItems([]); setLoading(false); return }
        const j = await r.json()
        setItems(j.telemetry || [])
        setLoading(false)
    }

    const [selected, setSelected] = useState<any | null>(null)

    const downloadCSV = async () => {
        const url = `/api/dashboard/telemetry/export?limit=100`;
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) { alert('CSV export failed'); return }
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = 'telemetry.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
    }

    return (
        <div className="min-h-screen bg-black text-[#e6e6e6]">
            <Sidebar />
            <div className="p-6 ml-24">
                <h1 className="text-3xl font-bold mb-4">Stream Telemetry</h1>

                <div className="flex gap-2 mb-4">
                    <input className="rounded p-2 bg-stone-900 border border-stone-800" placeholder="User id" value={user} onChange={(e) => setUser(e.target.value)} />
                    <input className="rounded p-2 bg-stone-900 border border-stone-800" placeholder="Embedding mode" value={mode} onChange={(e) => setMode(e.target.value)} />
                    <button className="rounded p-2 bg-stone-800" onClick={() => fetchTelemetry(user, mode)}>Filter</button>
                    <button className="rounded p-2 bg-stone-800" onClick={() => { setUser(''); setMode(''); fetchTelemetry(); }}>Reset</button>
                    <button className="rounded p-2 bg-emerald-700 ml-auto" onClick={downloadCSV}>Export CSV</button>
                </div>
                {selected && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                        <div className="bg-stone-900 rounded-2xl p-6 w-[min(800px,95%)]">
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="text-lg">Telemetry Details: {selected.id}</h3>
                                <button onClick={() => setSelected(null)} className="text-stone-400">Close</button>
                            </div>
                            <div className="text-sm mb-2">User: {selected.user_id || 'anonymous'}</div>
                            <div className="text-sm mb-2">Mode: {selected.embedding_mode || 'n/a'}</div>
                            <div className="text-sm mb-2">Duration: {selected.duration_ms} ms</div>
                            <div className="text-sm mb-2">Query: {selected.query}</div>
                            <div className="text-sm mb-2">Memory IDs:</div>
                            <ul className="list-disc ml-6 text-sm">
                                {(Array.isArray(selected.memory_ids) ? selected.memory_ids : JSON.parse(selected.memory_ids || '[]')).map((m: string) => (
                                    <li key={m}><a className="text-blue-300" href={`${API_BASE_URL}/memory/${m}`}>{m}</a></li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}

                <div className="bg-transparent rounded p-4 border border-[#27272a]">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-[#8a8a8a]">
                                <th>Time</th>
                                <th>User</th>
                                <th>Mode</th>
                                <th>Duration</th>
                                <th>Memory Count</th>
                                <th>Query</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={6} className="text-center py-4">Loading...</td></tr>
                            ) : items.length ? items.map((t: any, i: number) => (
                                <tr key={i} className="border-t border-[#27272a]">
                                    <td>{new Date(t.ts || Date.now()).toLocaleString()}</td>
                                    <td>{t.user_id || 'anonymous'}</td>
                                    <td>{t.embedding_mode || 'n/a'}</td>
                                    <td>{t.duration_ms}</td>
                                    <td>{Array.isArray(t.memory_ids) ? t.memory_ids.length : (t.memory_ids ? JSON.parse(t.memory_ids).length : 0)}</td>
                                    <td className="truncate max-w-[400px]">{t.query}</td>
                                    <td>
                                        <button onClick={() => setSelected(t)} className="text-sm text-blue-400">Details</button>
                                    </td>
                                </tr>
                            )) : (
                                <tr><td colSpan={6} className="text-center py-8">No telemetry found</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}

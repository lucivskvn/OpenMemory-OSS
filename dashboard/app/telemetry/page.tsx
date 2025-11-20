"use client"
import { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from '@/components/sidebar'
import { API_BASE_URL, getHeaders } from '@/lib/api'
import { formatTime } from '@/lib/time'

interface SystemHealth {
    ok: boolean
    version: string
    embedding: any
    tier: string
    dim: number
    cache: any
    expected: any
    ollama: any
}

interface SectorStats {
    sectors: string[]
    configs: any
    stats: any[]
}

export default function TelemetryPage() {
    const [telemetryItems, setTelemetryItems] = useState<any[]>([])
    const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null)
    const [sectorStats, setSectorStats] = useState<SectorStats | null>(null)
    const [loading, setLoading] = useState(true)
    const [healthLoading, setHealthLoading] = useState(false)
    const [user, setUser] = useState('')
    const [mode, setMode] = useState('')
    const [activeTab, setActiveTab] = useState<'telemetry' | 'system' | 'sectors'>('system')

    const [now] = useState(() => Date.now())

    const fetchTelemetry = useCallback(async (u?: string, m?: string) => {
        const params = new URLSearchParams()
        if (u) params.append('user_id', u)
        if (m) params.append('embedding_mode', m)
        params.append('limit', '50')

        const r = await fetch(`/api/dashboard/telemetry?${params.toString()}`)
        if (!r.ok) { setTelemetryItems([]); return }
        const j = await r.json()
        setTelemetryItems(j.telemetry || [])
    }, [])

    const fetchSystemHealth = useCallback(async () => {
        setHealthLoading(true)
        try {
            const res = await fetch('/api/system/health')
            if (res.ok) {
                const data = await res.json()
                setSystemHealth(data)
            }
        } catch (error) {
            console.error('Failed to fetch system health:', error)
        } finally {
            setHealthLoading(false)
        }
    }, [])

    const fetchSectorStats = useCallback(async () => {
        try {
            const res = await fetch('/api/system/sectors')
            if (res.ok) {
                const data = await res.json()
                setSectorStats(data)
            }
        } catch (error) {
            console.error('Failed to fetch sector stats:', error)
        }
    }, [])

    const fetchAllData = useCallback(async () => {
        setLoading(true)
        await Promise.all([
            fetchTelemetry(),
            fetchSystemHealth(),
            fetchSectorStats()
        ])
        setLoading(false)
    }, [fetchTelemetry, fetchSystemHealth, fetchSectorStats])

    useEffect(() => {
        fetchAllData()
    }, [fetchAllData])

    const getStatusColor = (status: boolean | string) => {
        if (typeof status === 'boolean') {
            return status ? 'text-green-400' : 'text-red-400'
        }
        switch (status) {
            case 'healthy': return 'text-green-400'
            case 'unavailable': return 'text-red-400'
            case 'error': return 'text-red-400'
            default: return 'text-stone-400'
        }
    }

    const getStatusIndicator = (status: boolean | string) => {
        const color = getStatusColor(status) === 'text-green-400' ? 'bg-green-500' : 'bg-red-500'
        return <div className={`w-2 h-2 rounded-full ${color}`}></div>
    }

    const tabs = [
        { id: 'system', label: 'System Health', count: null },
        { id: 'telemetry', label: 'Stream Telemetry', count: telemetryItems.length },
        { id: 'sectors', label: 'Memory Sectors', count: sectorStats?.stats?.length || 0 }
    ]

    return (
        <div className="min-h-screen bg-black text-[#e6e6e6]">
            <Sidebar />
            <div className="p-6 ml-24">
                <div className="flex items-center justify-between mb-6">
                    <h1 className="text-3xl font-bold">System Health & Telemetry</h1>
                    <button
                        onClick={fetchAllData}
                        disabled={loading || healthLoading}
                        className="rounded-xl p-2 px-4 bg-stone-800 hover:bg-stone-700 disabled:opacity-50"
                    >
                        {(loading || healthLoading) ? 'Refreshing...' : 'Refresh All'}
                    </button>
                </div>

                {/* Tab Navigation */}
                <div className="flex space-x-1 mb-6 bg-stone-900 p-1 rounded-xl w-fit">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id as any)}
                            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${activeTab === tab.id
                                ? 'bg-stone-700 text-white'
                                : 'text-stone-400 hover:text-stone-200'
                                }`}
                        >
                            {tab.label}
                            {tab.count !== null && (
                                <span className="ml-2 bg-stone-800 text-stone-300 px-2 py-0.5 rounded text-xs">
                                    {tab.count}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {/* System Health Tab */}
                {activeTab === 'system' && (
                    <div className="space-y-6">
                        {healthLoading && (
                            <div className="text-center text-stone-400 py-8">Loading system health...</div>
                        )}

                        {systemHealth && (
                            <>
                                {/* Status Cards */}
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
                                        <div className="flex items-center space-x-3 mb-4">
                                            {getStatusIndicator(systemHealth.ok)}
                                            <h3 className="text-lg font-medium">System Status</h3>
                                        </div>
                                        <div className="space-y-2">
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Overall:</span>
                                                <span className={getStatusColor(systemHealth.ok)}>
                                                    {systemHealth.ok ? 'Healthy' : 'Issues'}
                                                </span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Version:</span>
                                                <span className="text-stone-200">{systemHealth.version}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Tier:</span>
                                                <span className="text-stone-200 capitalize">{systemHealth.tier}</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
                                        <div className="flex items-center space-x-3 mb-4">
                                            <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                                            <h3 className="text-lg font-medium">Embeddings</h3>
                                        </div>
                                        <div className="space-y-2">
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Provider:</span>
                                                <span className="text-stone-200">{systemHealth.embedding?.kind || 'Unknown'}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Dimensions:</span>
                                                <span className="text-stone-200">{systemHealth.dim}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Model:</span>
                                                <span className="text-stone-200 font-mono text-sm">
                                                    {systemHealth.embedding?.model || 'n/a'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
                                        <div className="flex items-center space-x-3 mb-4">
                                            {getStatusIndicator(systemHealth.ollama?.available)}
                                            <h3 className="text-lg font-medium">Ollama</h3>
                                        </div>
                                        <div className="space-y-2">
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Status:</span>
                                                <span className={getStatusColor(systemHealth.ollama?.status || 'unavailable')}>
                                                    {systemHealth.ollama?.status || 'Unknown'}
                                                </span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Version:</span>
                                                <span className="text-stone-200">{systemHealth.ollama?.version || 'n/a'}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="text-stone-400">Models:</span>
                                                <span className="text-stone-200">{systemHealth.ollama?.models_loaded || 0}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Performance Metrics */}
                                {systemHealth.expected && (
                                    <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
                                        <h3 className="text-lg font-medium mb-4">Performance Expectations</h3>
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-blue-400">
                                                    {systemHealth.expected.recall}%
                                                </div>
                                                <div className="text-stone-400 text-sm">Recall</div>
                                            </div>
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-green-400">
                                                    {systemHealth.expected.qps}
                                                </div>
                                                <div className="text-stone-400 text-sm">Queries/sec</div>
                                            </div>
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-purple-400">
                                                    {systemHealth.expected.ram}
                                                </div>
                                                <div className="text-stone-400 text-sm">Memory/10k</div>
                                            </div>
                                            <div className="text-center">
                                                <div className="text-orange-400 text-sm mt-6">
                                                    {systemHealth.expected.use}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* System Information */}
                                <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
                                    <h3 className="text-lg font-medium mb-4">System Configuration</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                        <div>
                                            <h4 className="text-stone-300 mb-2">Embedding Configuration</h4>
                                            <div className="space-y-1 text-sm">
                                                <div className="flex justify-between">
                                                    <span className="text-stone-400">Type:</span>
                                                    <span>{systemHealth.embedding?.type || systemHealth.embedding?.kind}</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-stone-400">Mode:</span>
                                                    <span>{systemHealth.embedding?.mode}</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-stone-400">Dimensions:</span>
                                                    <span>{systemHealth.dim}</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-stone-400">Cache:</span>
                                                    <span>{systemHealth.cache ? 'Enabled' : 'Disabled'}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div>
                                            <h4 className="text-stone-300 mb-2">Memory Information</h4>
                                            <div className="space-y-1 text-sm">
                                                <div className="flex justify-between">
                                                    <span className="text-stone-400">Segment Cache:</span>
                                                    <span>{typeof systemHealth.cache === 'object' ? 'Configured' : systemHealth.cache}</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-stone-400">Vector Dim:</span>
                                                    <span>{systemHealth.dim}</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-stone-400">Tier:</span>
                                                    <span className="capitalize">{systemHealth.tier}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* Stream Telemetry Tab */}
                {activeTab === 'telemetry' && (
                    <div className="space-y-4">
                        <div className="flex gap-2 mb-4">
                            <input
                                className="rounded p-2 bg-stone-900 border border-stone-800"
                                placeholder="User id"
                                value={user}
                                onChange={(e) => setUser(e.target.value)}
                            />
                            <input
                                className="rounded p-2 bg-stone-900 border border-stone-800"
                                placeholder="Embedding mode"
                                value={mode}
                                onChange={(e) => setMode(e.target.value)}
                            />
                            <button
                                className="rounded p-2 bg-stone-800 hover:bg-stone-700"
                                onClick={() => fetchTelemetry(user, mode)}
                            >
                                Filter
                            </button>
                            <button
                                className="rounded p-2 bg-stone-800 hover:bg-stone-700"
                                onClick={() => { setUser(''); setMode(''); fetchTelemetry(); }}
                            >
                                Reset
                            </button>
                        </div>

                        <div className="bg-stone-950 rounded-xl p-4 border border-stone-800">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-stone-400 border-b border-stone-800">
                                        <th className="p-3">Time</th>
                                        <th className="p-3">User</th>
                                        <th className="p-3">Mode</th>
                                        <th className="p-3">Duration</th>
                                        <th className="p-3">Memories</th>
                                        <th className="p-3">Query</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {loading ? (
                                        <tr><td colSpan={6} className="text-center py-8 text-stone-400">Loading telemetry...</td></tr>
                                    ) : telemetryItems.length ? telemetryItems.map((t: any, i: number) => (
                                        <tr key={i} className="border-t border-stone-800">
                                            <td className="p-3 text-stone-300">
                                                {formatTime(t.ts || now)}
                                            </td>
                                            <td className="p-3 text-stone-300">{t.user_id || 'anonymous'}</td>
                                            <td className="p-3 text-stone-300">{t.embedding_mode || 'n/a'}</td>
                                            <td className="p-3 text-stone-300">{t.duration_ms}ms</td>
                                            <td className="p-3 text-stone-300">
                                                {Array.isArray(t.memory_ids) ? t.memory_ids.length : (t.memory_ids ? JSON.parse(t.memory_ids).length : 0)}
                                            </td>
                                            <td className="p-3 text-stone-200 truncate max-w-[400px]" title={t.query}>
                                                {t.query}
                                            </td>
                                        </tr>
                                    )) : (
                                        <tr><td colSpan={6} className="text-center py-8 text-stone-400">No telemetry found</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Memory Sectors Tab */}
                {activeTab === 'sectors' && (
                    <div className="space-y-4">
                        {sectorStats ? (
                            <>
                                <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
                                    <h3 className="text-lg font-medium mb-4">Sector Statistics</h3>
                                    <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
                                        {sectorStats.stats.map((stat: any) => (
                                            <div key={stat.sector} className="bg-stone-900 rounded-lg p-4">
                                                <div className="text-lg font-medium text-stone-200 capitalize mb-2">
                                                    {stat.sector}
                                                </div>
                                                <div className="space-y-1">
                                                    <div className="flex justify-between text-sm">
                                                        <span className="text-stone-400">Count:</span>
                                                        <span className="text-stone-200">{stat.count}</span>
                                                    </div>
                                                    <div className="flex justify-between text-sm">
                                                        <span className="text-stone-400">Avg Salience:</span>
                                                        <span className="text-stone-200">{(stat.avg_salience * 100).toFixed(1)}%</span>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="bg-stone-950 rounded-xl border border-stone-800 p-6">
                                    <h3 className="text-lg font-medium mb-4">Sector Configuration</h3>
                                    <div className="space-y-4">
                                        {sectorStats.sectors.map((sector: string) => (
                                            <div key={sector} className="border border-stone-800 rounded-lg p-4">
                                                <div className="flex items-center justify-between mb-2">
                                                    <h4 className="text-stone-200 font-medium capitalize">{sector}</h4>
                                                    <span className="text-stone-400 text-sm">
                                                        Configured
                                                    </span>
                                                </div>
                                                {sectorStats.configs[sector] && (
                                                    <div className="text-stone-400 text-sm space-y-1">
                                                        <div>Description: {sectorStats.configs[sector].description || 'Memory sector configuration'}</div>
                                                        <div>Decay Factor: {sectorStats.configs[sector].decay_factor || 'n/a'}</div>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="text-center text-stone-400 py-8">Loading sector statistics...</div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}

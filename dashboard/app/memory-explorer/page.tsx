"use client"

import { useState, useEffect, useCallback } from "react"
import { API_BASE_URL, getHeaders } from "@/lib/api"
import { formatTime } from "@/lib/time"

interface Memory {
    id: string
    content: string
    primary_sector: string
    sectors?: string[]
    tags?: string[]
    metadata?: any
    created_at: number
    updated_at?: number
    last_seen_at?: number
    salience: number
    decay_lambda?: number
    version?: number
    user_id?: string
}

const sectorColors: Record<string, string> = {
    semantic: "sky",
    episodic: "amber",
    procedural: "emerald",
    emotional: "rose",
    reflective: "purple"
}

export default function MemoryExplorerPage() {
    const [memories, setMemories] = useState<Memory[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Search filters
    const [userId, setUserId] = useState("")
    const [embeddingMode, setEmbeddingMode] = useState("")
    const [dateRange, setDateRange] = useState("")
    const [searchQuery, setSearchQuery] = useState("")

    // Pagination
    const [currentPage, setCurrentPage] = useState(1)
    const [totalCount, setTotalCount] = useState(0)
    const [limit] = useState(25)

    // Selection for bulk operations
    const [selectedMemories, setSelectedMemories] = useState<Set<string>>(new Set())

    // Modal states
    const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null)
    const [showDetailModal, setShowDetailModal] = useState(false)
    const [showBulkModal, setShowBulkModal] = useState(false)

    const fetchMemories = useCallback(async (resetPage = false) => {
        setLoading(true)
        setError(null)

        try {
            const page = resetPage ? 1 : currentPage
            const offset = (page - 1) * limit

            let endpoint = '/api/memory/all'
            let queryParams = new URLSearchParams({
                limit: limit.toString(),
                offset: offset.toString(),
            })

            if (userId) queryParams.set('user_id', userId)

            // If we have a search query, use the query endpoint instead
            if (searchQuery.trim()) {
                endpoint = '/api/memory/query'
                const queryBody = {
                    query: searchQuery.trim(),
                    k: limit,
                    filters: {
                        user_id: userId || undefined,
                    }
                }

                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: getHeaders(),
                    body: JSON.stringify(queryBody),
                })

                if (!res.ok) throw new Error('Search failed')
                const data = await res.json()
                setMemories(data.matches || [])
                setTotalCount((data.matches || []).length)
                setSelectedMemories(new Set())
                if (resetPage) setCurrentPage(1)
                return
            }

            // Regular fetch without search
            const url = `${endpoint}?${queryParams}`
            const res = await fetch(url, { headers: getHeaders() })

            if (!res.ok) throw new Error('Failed to fetch memories')
            const data = await res.json()
            setMemories(data.items || [])
            setTotalCount((data.items || []).length)
            setSelectedMemories(new Set())

        } catch (err: any) {
            setError(err.message)
        } finally {
            setLoading(false)
        }

        if (resetPage) setCurrentPage(1)
    }, [currentPage, limit, userId, searchQuery])

    useEffect(() => {
        fetchMemories()
    }, [fetchMemories])

    const handleSearch = () => {
        fetchMemories(true)
    }

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSearch()
        }
    }

    const handleSelectAll = (checked: boolean) => {
        if (checked) {
            setSelectedMemories(new Set(memories.map(m => m.id)))
        } else {
            setSelectedMemories(new Set())
        }
    }

    const handleSelectMemory = (id: string, checked: boolean) => {
        const newSelected = new Set(selectedMemories)
        if (checked) {
            newSelected.add(id)
        } else {
            newSelected.delete(id)
        }
        setSelectedMemories(newSelected)
    }

    const handleBulkDelete = async () => {
        if (selectedMemories.size === 0) return

        try {
            const promises = Array.from(selectedMemories).map(id =>
                fetch(`/api/memory/${id}`, { method: 'DELETE' })
            )
            await Promise.all(promises)
            setSelectedMemories(new Set())
            setShowBulkModal(false)
            fetchMemories() // Refresh the list
        } catch (err: any) {
            alert(`Error deleting memories: ${err.message}`)
        }
    }

    const handleExport = () => {
        const exportData = memories.filter(m => selectedMemories.has(m.id))
        const blob = new Blob([JSON.stringify(exportData, null, 2)], {
            type: 'application/json'
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `memories-export-${new Date().toISOString().split('T')[0]}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    const totalPages = Math.ceil(totalCount / limit)

    return (
        <div className="min-h-screen">
            <div className="flex items-center justify-between mb-6">
                <h1 className="text-white text-2xl">Memory Explorer</h1>
                <div className="flex gap-2">
                    {selectedMemories.size > 0 && (
                        <>
                            <button
                                onClick={() => setShowBulkModal(true)}
                                className="rounded-xl p-2 px-4 bg-rose-500 hover:bg-rose-600 text-white"
                            >
                                Delete Selected ({selectedMemories.size})
                            </button>
                            <button
                                onClick={handleExport}
                                className="rounded-xl p-2 px-4 bg-blue-500 hover:bg-blue-600 text-white"
                            >
                                Export Selected
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Search Form */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div>
                    <label className="text-stone-400 text-sm mb-2 block">User ID</label>
                    <input
                        type="text"
                        value={userId}
                        onChange={(e) => setUserId(e.target.value)}
                        className="w-full bg-stone-950 rounded-xl border border-stone-800 outline-none p-3 text-stone-300"
                        placeholder="Filter by user ID"
                    />
                </div>
                <div>
                    <label className="text-stone-400 text-sm mb-2 block">Embedding Mode</label>
                    <select
                        value={embeddingMode}
                        onChange={(e) => setEmbeddingMode(e.target.value)}
                        className="w-full bg-stone-950 rounded-xl border border-stone-800 outline-none p-3 text-stone-300"
                    >
                        <option value="">All</option>
                        <option value="simple">Simple</option>
                        <option value="advanced">Advanced</option>
                    </select>
                </div>
                <div>
                    <label className="text-stone-400 text-sm mb-2 block">Date Range</label>
                    <select
                        value={dateRange}
                        onChange={(e) => setDateRange(e.target.value)}
                        className="w-full bg-stone-950 rounded-xl border border-stone-800 outline-none p-3 text-stone-300"
                    >
                        <option value="">All time</option>
                        <option value="today">Today</option>
                        <option value="week">This week</option>
                        <option value="month">This month</option>
                    </select>
                </div>
                <div>
                    <label className="text-stone-400 text-sm mb-2 block">Search Content</label>
                    <div className="relative">
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyPress={handleKeyPress}
                            className="w-full bg-stone-950 rounded-xl border border-stone-800 outline-none p-3 pl-10 text-stone-300"
                            placeholder="Search memories..."
                        />
                        <button
                            onClick={handleSearch}
                            className="absolute right-1 top-1 p-2 bg-stone-900 rounded-lg hover:bg-stone-800"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="size-4">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                            </svg>
                        </button>
                    </div>
                </div>
            </div>

            {/* Table */}
            <div className="bg-stone-950 rounded-xl border border-stone-800 overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead className="bg-stone-900">
                            <tr>
                                <th className="px-4 py-3 text-left">
                                    <input
                                        type="checkbox"
                                        checked={selectedMemories.size === memories.length && memories.length > 0}
                                        onChange={(e) => handleSelectAll(e.target.checked)}
                                        className="rounded border-stone-600"
                                    />
                                </th>
                                <th className="px-4 py-3 text-left text-stone-400">Content</th>
                                <th className="px-4 py-3 text-left text-stone-400">Sector</th>
                                <th className="px-4 py-3 text-left text-stone-400">Salience</th>
                                <th className="px-4 py-3 text-left text-stone-400">Created</th>
                                <th className="px-4 py-3 text-left text-stone-400">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading && (
                                <tr>
                                    <td colSpan={6} className="px-4 py-8 text-center text-stone-400">
                                        Loading memories...
                                    </td>
                                </tr>
                            )}
                            {error && (
                                <tr>
                                    <td colSpan={6} className="px-4 py-8 text-center text-rose-400">
                                        Error: {error}
                                    </td>
                                </tr>
                            )}
                            {!loading && !error && memories.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-4 py-8 text-center text-stone-400">
                                        No memories found. Try adjusting your filters.
                                    </td>
                                </tr>
                            )}
                            {memories.map((memory) => (
                                <tr key={memory.id} className="border-t border-stone-800 hover:bg-stone-900/50">
                                    <td className="px-4 py-3">
                                        <input
                                            type="checkbox"
                                            checked={selectedMemories.has(memory.id)}
                                            onChange={(e) => handleSelectMemory(memory.id, e.target.checked)}
                                            className="rounded border-stone-600"
                                        />
                                    </td>
                                    <td className="px-4 py-3 text-stone-200 max-w-xs truncate">
                                        {memory.content}
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className={`bg-${sectorColors[memory.primary_sector] || 'gray'}-500/10 border border-${sectorColors[memory.primary_sector] || 'gray'}-500/20 text-${sectorColors[memory.primary_sector] || 'gray'}-400 px-2 py-1 rounded text-xs`}>
                                            {memory.primary_sector}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-stone-400">
                                        {(memory.salience * 100).toFixed(1)}%
                                    </td>
                                    <td className="px-4 py-3 text-stone-400 text-sm">
                                        {formatTime(memory.created_at, { dateOnly: true })}
                                    </td>
                                    <td className="px-4 py-3">
                                        <button
                                            onClick={() => {
                                                setSelectedMemory(memory)
                                                setShowDetailModal(true)
                                            }}
                                            className="text-blue-400 hover:text-blue-300 text-sm"
                                        >
                                            View
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between mt-6">
                    <div className="text-stone-400">
                        Showing {((currentPage - 1) * limit) + 1} to {Math.min(currentPage * limit, totalCount)} of {totalCount} memories
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={currentPage === 1 || loading}
                            className="rounded-xl p-2 px-4 bg-stone-900 hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Previous
                        </button>
                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                            const page = Math.max(1, Math.min(totalPages - 4, currentPage - 2)) + i
                            return (
                                <button
                                    key={page}
                                    onClick={() => setCurrentPage(page)}
                                    disabled={loading}
                                    className={`rounded-xl p-2 px-4 ${currentPage === page ? 'bg-sky-500 text-white' : 'bg-stone-900 hover:bg-stone-800'} disabled:opacity-50`}
                                >
                                    {page}
                                </button>
                            )
                        })}
                        <button
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={currentPage === totalPages || loading}
                            className="rounded-xl p-2 px-4 bg-stone-900 hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Next
                        </button>
                    </div>
                </div>
            )}

            {/* Detail Modal */}
            {showDetailModal && selectedMemory && (
                <MemoryDetailModal
                    memory={selectedMemory}
                    onClose={() => {
                        setShowDetailModal(false)
                        setSelectedMemory(null)
                    }}
                />
            )}

            {/* Bulk Delete Confirmation */}
            {showBulkModal && (
                <BulkDeleteModal
                    count={selectedMemories.size}
                    onConfirm={handleBulkDelete}
                    onClose={() => setShowBulkModal(false)}
                />
            )}
        </div>
    )
}

function MemoryDetailModal({ memory, onClose }: { memory: Memory; onClose: () => void }) {
    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
            <div className="bg-stone-950 rounded-xl p-6 max-w-2xl w-full mx-4 border border-stone-800 max-h-[80vh] overflow-y-auto">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl text-white">Memory Details</h2>
                    <button
                        onClick={onClose}
                        className="text-stone-400 hover:text-stone-200"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="size-6">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="text-stone-400 text-sm block">ID</label>
                        <div className="font-mono text-stone-200 bg-stone-900 p-2 rounded text-sm break-all">
                            {memory.id}
                        </div>
                    </div>

                    <div>
                        <label className="text-stone-400 text-sm block">Content</label>
                        <div className="text-stone-200 bg-stone-900 p-3 rounded whitespace-pre-wrap">
                            {memory.content}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-stone-400 text-sm block">Primary Sector</label>
                            <span className={`bg-${sectorColors[memory.primary_sector] || 'gray'}-500/10 border border-${sectorColors[memory.primary_sector] || 'gray'}-500/20 text-${sectorColors[memory.primary_sector] || 'gray'}-400 px-2 py-1 rounded text-sm`}>
                                {memory.primary_sector}
                            </span>
                        </div>

                        <div>
                            <label className="text-stone-400 text-sm block">Salience</label>
                            <div className="text-stone-200">{(memory.salience * 100).toFixed(1)}%</div>
                        </div>
                    </div>

                    {memory.tags && memory.tags.length > 0 && (
                        <div>
                            <label className="text-stone-400 text-sm block">Tags</label>
                            <div className="flex flex-wrap gap-2">
                                {memory.tags.map((tag, i) => (
                                    <span key={i} className="bg-stone-800 text-stone-300 px-2 py-1 rounded text-sm">
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="text-stone-400 text-sm block">Created</label>
                            <div className="text-stone-200 text-sm">
                                {formatTime(memory.created_at)}
                            </div>
                        </div>

                        {memory.last_seen_at && (
                            <div>
                                <label className="text-stone-400 text-sm block">Last Seen</label>
                                <div className="text-stone-200 text-sm">
                                    {formatTime(memory.last_seen_at)}
                                </div>
                            </div>
                        )}
                    </div>

                    {memory.metadata && (
                        <div>
                            <label className="text-stone-400 text-sm block">Metadata</label>
                            <pre className="text-stone-200 bg-stone-900 p-3 rounded text-xs overflow-x-auto">
                                {JSON.stringify(memory.metadata, null, 2)}
                            </pre>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

function BulkDeleteModal({ count, onConfirm, onClose }: { count: number; onConfirm: () => void; onClose: () => void }) {
    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
            <div className="bg-stone-950 rounded-xl p-6 max-w-md w-full mx-4 border border-stone-800">
                <h2 className="text-xl text-white mb-4">Delete Memories</h2>
                <p className="text-stone-400 mb-6">
                    Are you sure you want to delete {count} selected memories? This action cannot be undone.
                </p>
                <div className="flex space-x-3">
                    <button
                        onClick={onConfirm}
                        className="flex-1 rounded-xl p-2 bg-rose-500 hover:bg-rose-600 text-white"
                    >
                        Delete {count} Memories
                    </button>
                    <button
                        onClick={onClose}
                        className="flex-1 rounded-xl p-2 bg-stone-800 hover:bg-stone-700 text-white"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    )
}

"use client";

import { useEffect, useState } from "react";
import { api, Memory } from "@/lib/api";
import { MemoryCard } from "@/components/MemoryCard";
import { Search, Loader2 } from "lucide-react";

export default function MemoryStorePage() {
    const [memories, setMemories] = useState<Memory[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");
    const [isSearching, setIsSearching] = useState(false);

    useEffect(() => {
        load();
    }, []);

    const load = async () => {
        setLoading(true);
        try {
            const m = await api.getMemories(50);
            setMemories(m);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    };

    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!query.trim()) {
            load();
            return;
        }
        setIsSearching(true);
        try {
            const m = await api.searchMemories(query);
            setMemories(m);
        } catch (e) {
            console.error(e);
        } finally {
            setIsSearching(false);
        }
    };

    const handleReinforce = (id: string) => {
        api.reinforceMemory(id).catch(console.error);
    };

    return (
        <div className="flex flex-col gap-8">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 glass-card p-4">
                <h1 className="text-2xl font-bold">Memory Store</h1>
                <form onSubmit={handleSearch} className="flex-1 max-w-md relative">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search memories..."
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 pl-10 focus:outline-none focus:border-primary/50 transition-all"
                    />
                    <Search className="absolute left-3 top-2.5 text-gray-500" size={18} />
                    {isSearching && (
                        <Loader2 className="absolute right-3 top-2.5 text-primary animate-spin" size={18} />
                    )}
                </form>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {loading ? (
                    <div className="col-span-full flex flex-col items-center justify-center py-20 text-gray-500">
                        <Loader2 className="animate-spin mb-4" size={32} />
                        <p>Accessing memory traces...</p>
                    </div>
                ) : memories.length === 0 ? (
                    <div className="col-span-full text-center py-20 text-gray-500 italic">
                        No memories found matching your criteria.
                    </div>
                ) : (
                    memories.map((mem) => (
                        <MemoryCard
                            key={mem.id}
                            memory={mem}
                            onReinforce={handleReinforce}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

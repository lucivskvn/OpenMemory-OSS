"use client";

import { useEffect, useState } from "react";
import { api, Memory } from "@/lib/api";
import { MemoryCard } from "@/components/MemoryCard";
import { Search, Loader2, Database } from "lucide-react";
import { cn } from "@/lib/utils";

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
            const m = await api.getMemories(50) as Memory[];
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
            const m = await api.searchMemories(query) as Memory[];
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
        <div className="flex flex-col gap-8 animate-in fade-in duration-700">
            <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 glass-card border-primary/10">
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-primary/10 rounded-2xl text-primary shadow-inner">
                        <Database size={28} />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black tracking-tight text-white">Memory Store</h1>
                        <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1">
                            Neural Trace Explorer
                        </p>
                    </div>
                </div>

                <form onSubmit={handleSearch} className="flex-1 max-w-xl relative group">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Query neural network..."
                        className="w-full bg-black/40 border border-white/10 rounded-2xl px-6 py-4 pl-14 focus:outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all text-sm font-medium placeholder:text-zinc-600"
                    />
                    <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-zinc-600 group-focus-within:text-primary transition-colors" size={20} />
                    {isSearching && (
                        <Loader2 className="absolute right-5 top-1/2 -translate-y-1/2 text-primary animate-spin" size={20} />
                    )}
                </form>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
                {loading ? (
                    <div className="col-span-full flex flex-col items-center justify-center py-32 text-zinc-500 gap-6">
                        <div className="relative">
                            <Loader2 className="animate-spin text-primary" size={48} strokeWidth={1} />
                            <div className="absolute inset-0 blur-2xl bg-primary/20 animate-pulse" />
                        </div>
                        <div className="text-center">
                            <p className="font-black text-[10px] uppercase tracking-[0.2em] mb-2 opacity-50">Synchronizing</p>
                            <p className="text-sm font-medium italic">Accessing cortical memory traces...</p>
                        </div>
                    </div>
                ) : memories.length === 0 ? (
                    <div className="col-span-full text-center py-32 glass-card border-dashed border-white/10 opacity-60">
                        <Search className="mx-auto mb-4 text-zinc-700" size={48} strokeWidth={1} />
                        <p className="text-sm font-medium text-zinc-500 italic">
                            No matching neural patterns identified.
                        </p>
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

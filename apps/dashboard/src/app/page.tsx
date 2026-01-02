"use client";
import { useEffect, useState } from "react";
import { api, SystemStats, Memory } from "../lib/api";
import { StatsGrid } from "../components/StatsGrid";
import { MemoryCard } from "../components/MemoryCard";
import { TemporalGraph } from "../components/TemporalGraph";

export default function Home() {
    const [stats, setStats] = useState<SystemStats | null>(null);
    const [recent, setRecent] = useState<Memory[]>([]);

    useEffect(() => {
        const load = async () => {
            try {
                const [s, m] = await Promise.all([
                    api.getStats(),
                    api.getMemories(5)
                ]);
                setStats(s);
                setRecent(m);
            } catch (e) {
                console.error("Failed to load dashboard data", e);
            }
        };
        load();
        const interval = setInterval(load, 5000);
        return () => clearInterval(interval);
    }, []);

    const handleReinforce = (id: string) => {
        api.reinforceMemory(id).catch(console.error);
    };

    return (
        <div className="flex flex-col gap-8 text-white">
            <StatsGrid stats={stats} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <TemporalGraph />

                {/* Memory Feed */}
                <div className="glass-card flex flex-col gap-4 max-h-[400px]">
                    <h2 className="text-xl font-bold px-1">Recent Memories</h2>
                    <div className="flex-1 overflow-y-auto pr-2 flex flex-col gap-3 custom-scrollbar">
                        {recent.map((mem) => (
                            <MemoryCard
                                key={mem.id}
                                memory={mem}
                                onReinforce={handleReinforce}
                            />
                        ))}
                        {recent.length === 0 && (
                            <div className="text-center text-gray-500 py-4 italic">No recent memories found</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

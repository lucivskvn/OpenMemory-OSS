import { motion } from "framer-motion";
import { Brain, Zap, Clock, TrendingUp } from "lucide-react";
import type { SystemStats } from "@/lib/api";
import { cn } from "@/lib/utils";

interface StatsGridProps {
    stats: SystemStats | null;
}

export const StatsGrid = ({ stats }: StatsGridProps) => {
    const errorRate = parseFloat(stats?.requests.errorRate || "0");
    const successRate = 100 - errorRate;

    const statItems = [
        {
            label: "Throughput",
            value: `${stats?.qps.average || "0"} QPS`,
            icon: Zap,
            color: "text-yellow-400",
            bg: "bg-yellow-400/10"
        },
        {
            label: "Success Rate",
            value: `${successRate.toFixed(1)}%`,
            icon: TrendingUp,
            color: "text-green-400",
            bg: "bg-green-400/10"
        },
        {
            label: "Uptime",
            value: (() => {
                const { days, hours, seconds } = stats?.system.uptime || { days: 0, hours: 0, seconds: 0 };
                if (days > 0) return `${days}d ${hours}h`;
                return `${hours}h ${(seconds || 0) % 60}s`;
            })(),
            icon: Clock,
            color: "text-purple-400",
            bg: "bg-purple-400/10"
        },
        {
            label: "Memories",
            value: stats?.totalMemories.toLocaleString() || "0",
            icon: Brain,
            color: "text-blue-400",
            bg: "bg-blue-400/10"
        },
    ];

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {statItems.map((stat, i) => (
                <motion.div
                    key={stat.label}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    whileHover={{ y: -5, transition: { type: "spring", stiffness: 300 } }}
                    transition={{ delay: i * 0.1 }}
                    className="backdrop-blur-xl bg-white/5 border border-white/10 shadow-xl shadow-black/20 rounded-2xl p-6 flex items-center gap-5 hover:border-primary/30 hover:bg-white/10 transition-all group cursor-default"
                >
                    <div className={cn(
                        "p-4 rounded-xl group-hover:scale-110 transition-transform duration-300 shadow-inner",
                        stat.bg,
                        stat.color
                    )}>
                        <stat.icon size={28} strokeWidth={1.5} />
                    </div>
                    <div>
                        <p className="text-zinc-500 text-[10px] uppercase tracking-widest font-black mb-1">{stat.label}</p>
                        <h3 className="text-3xl font-black tracking-tighter text-white group-hover:text-primary transition-colors">
                            {stat.value}
                        </h3>
                    </div>
                </motion.div>
            ))}
        </div>
    );
};

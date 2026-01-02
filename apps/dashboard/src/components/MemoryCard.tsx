import { motion } from "framer-motion";
import { Zap, Lock, Minimize2 } from "lucide-react";
import { Memory } from "../lib/api";

interface MemoryCardProps {
    memory: Memory;
    onReinforce: (id: string) => void;
}

/**
 * Component to display a single Memory item.
 * Features:
 * - Security Badges (Encrypted, Compressed)
 * - Metadata inspection
 * - Reinforcement action
 */
export const MemoryCard = ({ memory, onReinforce }: MemoryCardProps) => {
    const isEncrypted = memory.metadata?.encrypted || memory.content.startsWith("enc:") || memory.content.includes("iv:");
    const isCompressed = !!memory.compressed_vec;

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            className="p-5 rounded-xl bg-white/5 backdrop-blur-md border border-white/10 shadow-lg shadow-black/20 hover:border-primary/30 hover:shadow-primary/5 transition-all group relative overflow-hidden"
        >
            <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

            <div className="flex items-center justify-between mb-3 relative z-10">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-widest text-primary/80 font-semibold bg-primary/10 px-2 py-0.5 rounded-full border border-primary/20">
                        {memory.primary_sector || "Unclassified"}
                    </span>

                    {/* Security Badge */}
                    {isEncrypted && (
                        <div className="text-emerald-400 flex items-center gap-1 bg-emerald-400/10 px-1.5 py-0.5 rounded text-[10px] border border-emerald-400/20" title="Encrypted at Rest">
                            <Lock size={10} />
                            <span>AES</span>
                        </div>
                    )}

                    {/* Compression Badge */}
                    {isCompressed && (
                        <div className="text-blue-400 flex items-center gap-1 bg-blue-400/10 px-1.5 py-0.5 rounded text-[10px] border border-blue-400/20" title="Vector Compressed">
                            <Minimize2 size={10} />
                            <span>PQ</span>
                        </div>
                    )}
                </div>
                <span className="text-[10px] text-gray-400 font-mono">
                    {new Date(memory.created_at).toLocaleTimeString()}
                </span>
            </div>

            <div className="flex items-start justify-between gap-4 relative z-10">
                <p className="text-sm text-gray-200 line-clamp-2 flex-1 break-words font-light leading-relaxed">
                    {memory.content}
                </p>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onReinforce(memory.id);
                    }}
                    className="text-yellow-500 hover:text-yellow-400 p-1.5 bg-yellow-500/10 hover:bg-yellow-500/20 rounded-lg opacity-0 group-hover:opacity-100 transition-all transform hover:scale-110"
                    title="Reinforce Memory"
                >
                    <Zap size={14} />
                </button>
            </div>

            {/* Metadata Footer */}
            {memory.metadata && (
                <div className="mt-3 pt-2 border-t border-white/5 flex gap-2 relative z-10">
                    {Object.entries(memory.metadata).slice(0, 2).map(([k, v]) => (
                        <span key={k} className="text-[9px] text-gray-500 bg-black/30 px-1.5 py-0.5 rounded border border-white/5">
                            {k}: {(typeof v === 'object') ? '...' : String(v)}
                        </span>
                    ))}
                </div>
            )}
        </motion.div>
    );
};

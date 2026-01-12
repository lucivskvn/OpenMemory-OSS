import { motion } from "framer-motion";
import { Zap, Lock, Minimize2, Brain, Check, Copy } from "lucide-react";
import { Memory } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useState } from "react";

const CopyButton = ({ content }: { content: string }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            onClick={handleCopy}
            className={cn(
                "p-2 rounded-lg transition-all duration-300 transform hover:scale-110",
                copied
                    ? "text-emerald-400 bg-emerald-400/10 shadow-inner shadow-emerald-400/20"
                    : "text-zinc-500 hover:text-white bg-white/5 hover:bg-white/10"
            )}
            title="Copy Content"
        >
            {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
    );
};

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
    const isEncrypted = memory.metadata?.encrypted === true || (typeof memory.content === 'string' && (memory.content.startsWith("enc:") || memory.content.startsWith("v1:") || memory.content.includes("iv:")));
    const isCompressed = !!memory.compressedVecStr || memory.metadata?.compressed === true;

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            whileHover={{ y: -4 }}
            className={cn(
                "glass-card p-5 hover:border-primary/40 group overflow-hidden flex flex-col h-full",
                "bg-white/5" // Keep slightly brighter background for cards vs containers
            )}
        >
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

            <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="text-[10px] font-black uppercase tracking-widest text-primary bg-primary/10 px-2.5 py-1 rounded-md border border-primary/20 shadow-sm shadow-primary/10">
                    {memory.primarySector || "Unclassified"}
                </span>

                {/* Security Badge */}
                {isEncrypted && (
                    <div className="text-emerald-400 flex items-center gap-1 bg-emerald-400/10 px-2 py-1 rounded-md text-[9px] font-bold border border-emerald-400/20" title="Encrypted at Rest">
                        <Lock size={10} />
                        <span>AES</span>
                    </div>
                )}

                {/* Compression Badge */}
                {isCompressed && (
                    <div className="text-blue-400 flex items-center gap-1 bg-blue-400/10 px-2 py-1 rounded-md text-[9px] font-bold border border-blue-400/20" title="Vector Compressed">
                        <Minimize2 size={10} />
                        <span>PQ</span>
                    </div>
                )}
                {/* Reflection Badge */}
                {memory.metadata?.type === "reflection" && (
                    <div className="text-purple-400 flex items-center gap-1 bg-purple-400/10 px-2 py-1 rounded-md text-[9px] font-bold border border-purple-400/20" title="Self-Reflection">
                        <Brain size={10} />
                        <span>REFLECTION</span>
                    </div>
                )}

                {/* Volatile Badge (High Decay) */}
                {(memory.decayLambda > 0.05) && (
                    <div className="text-orange-400 flex items-center gap-1 bg-orange-400/10 px-2 py-1 rounded-md text-[9px] font-bold border border-orange-400/20" title="High Decay Rate (Volatile)">
                        <Zap size={10} />
                        <span>VOLATILE</span>
                    </div>
                )}

                <div className="flex-1" />

                <span className="text-[10px] text-zinc-600 font-bold tabular-nums">
                    {new Date(memory.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
            </div>

            <div className="flex items-start justify-between gap-4 flex-1">
                <p className="text-sm text-zinc-300 font-medium leading-relaxed group-hover:text-white transition-colors duration-300">
                    {memory.content}
                </p>
                <div className="flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity translate-x-2 group-hover:translate-x-0 duration-300">
                    <CopyButton content={memory.content} />
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onReinforce(memory.id);
                        }}
                        className="text-yellow-500 hover:text-white p-2 bg-yellow-500/10 hover:bg-yellow-500 rounded-lg transition-all shadow-lg hover:shadow-yellow-500/40"
                        title="Reinforce Memory"
                    >
                        <Zap size={14} className="fill-current" />
                    </button>
                </div>
            </div>

            {/* Metadata Footer */}
            {memory.metadata && (
                <div className="mt-4 pt-4 border-t border-white/5 flex flex-wrap gap-2">
                    {Object.entries(memory.metadata)
                        .filter(([k]) => !['encrypted', 'compressed', 'type'].includes(k))
                        .slice(0, 3)
                        .map(([k, v]) => (
                            <span key={k} className="text-[9px] font-bold text-zinc-500 bg-black/40 px-2 py-1 rounded border border-white/5 hover:border-zinc-700 transition-colors uppercase tracking-tight" title={`${k}: ${v}`}>
                                {k}: <span className="text-zinc-400 font-medium">{(typeof v === 'object') ? '...' : String(v)}</span>
                            </span>
                        ))
                    }
                </div>
            )}
        </motion.div>
    );
};

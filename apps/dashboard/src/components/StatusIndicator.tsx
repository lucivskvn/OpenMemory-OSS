"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Activity, Zap, ZapOff } from "lucide-react";

export const StatusIndicator = () => {
    const [isOnline, setIsOnline] = useState<boolean | null>(null);

    useEffect(() => {
        const check = async () => {
            try {
                const status = await api.getHealth();
                setIsOnline(!!status);
            } catch {
                setIsOnline(false);
            }
        };
        check();
        const interval = setInterval(check, 10000); // Check every 10s
        return () => clearInterval(interval);
    }, []);

    if (isOnline === null) return null; // Initial loading state

    return (
        <div className={cn(
            "px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-2 border transition-all duration-500 shadow-lg",
            isOnline
                ? "bg-green-500/10 text-green-400 border-green-500/20 shadow-green-500/5"
                : "bg-red-500/10 text-red-400 border-red-500/20 shadow-red-500/5"
        )}>
            <span className={cn(
                "w-2 h-2 rounded-full",
                isOnline ? "bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]" : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]"
            )} />
            {isOnline ? <Zap className="w-3 h-3 fill-current" /> : <ZapOff className="w-3 h-3" />}
            {isOnline ? "System Online" : "Connection Lost"}
        </div>
    );
};

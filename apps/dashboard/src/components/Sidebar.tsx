"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Brain, Database, Settings, Activity, Wifi, Shield, Download, ChevronLeft, ChevronRight } from "lucide-react";
import { client } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { OpenMemoryEvent } from "@/lib/types";

export const Sidebar = () => {
    const pathname = usePathname();
    const [collapsed, setCollapsed] = useState(false);
    const [lastSuggestion, setLastSuggestion] = useState<string | null>(null);
    const [isLive, setIsLive] = useState(false);

    useEffect(() => {
        // Connect to stream
        const cleanup = client.listen((evt: OpenMemoryEvent) => {
            // Any event means we are live
            setIsLive(true);

            if (evt.type === 'ide_suggestion') {
                setLastSuggestion(`Suggestion: ${evt.data.topPattern.description}`);
                // Clear after 5s
                setTimeout(() => setLastSuggestion(null), 5000);
            }
        });
        return () => {
            cleanup();
            setIsLive(false);
        };
    }, []);

    const navItems = [
        { href: "/", label: "Dashboard", icon: LayoutDashboard },
        { href: "/graph", label: "Temporal Graph", icon: Activity },
        { href: "/dynamics", label: "Dynamics Graph", icon: Brain },
        { href: "/memory", label: "Memory Store", icon: Database },
        { href: "/audit", label: "Audit Logs", icon: Wifi },
        { href: "/admin", label: "Security & Users", icon: Shield },
        { href: "/portability", label: "Data Portability", icon: Download },
        { href: "/settings", label: "System Config", icon: Settings },
    ];

    return (
        <aside className={cn(
            "border-r border-white/5 bg-background flex flex-col p-4 md:p-6 gap-8 transition-all duration-300 relative group/sidebar",
            collapsed ? "w-20" : "w-64"
        )}>
            {/* Collapse Toggle */}
            <button
                onClick={() => setCollapsed(!collapsed)}
                className="absolute -right-3 top-8 bg-black/50 backdrop-blur border border-white/10 rounded-full p-1 text-white hover:bg-primary transition-colors shadow-lg opacity-0 group-hover/sidebar:opacity-100 z-10"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
                {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>

            <Link href="/" className="flex items-center justify-center md:justify-start gap-2 mb-4 group">
                <div className="w-10 h-10 md:w-8 md:h-8 rounded-xl md:rounded-lg bg-primary flex items-center justify-center shadow-lg shadow-primary/20 group-hover:scale-110 transition-transform">
                    <Brain className="w-6 h-6 md:w-5 md:h-5 text-white" />
                </div>
                {!collapsed && <span className="hidden md:block font-bold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60 animate-in fade-in">OpenMemory</span>}
            </Link>

            <nav className="flex-1 flex flex-col gap-2">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = pathname === item.href;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "flex items-center gap-3 px-3 py-2 rounded-lg transition-colors",
                                isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-white/5 hover:text-white",
                                collapsed && "justify-center"
                            )}
                            title={item.label}
                            aria-label={item.label}
                        >
                            <Icon size={20} className={isActive ? "text-primary" : "text-current"} />
                            {!collapsed && <span className="hidden md:block animate-in fade-in slide-in-from-left-2">{item.label}</span>}
                        </Link>
                    );
                })}
                <Link
                    href="/settings"
                    className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-lg text-muted-foreground hover:bg-white/5 hover:text-white transition-colors cursor-pointer mt-auto",
                        collapsed && "justify-center"
                    )}
                    aria-label="Settings"
                >
                    <Settings size={20} />
                    {!collapsed && <span className="hidden md:block animate-in fade-in">Settings</span>}
                </Link>

                <div className="mt-4">
                    {/* Suggestion Toast */}
                    {!collapsed && lastSuggestion && (
                        <div className="mb-2 p-2 text-xs bg-blue-500/10 border border-blue-500/20 text-blue-200 rounded animate-in fade-in slide-in-from-bottom-2">
                            {lastSuggestion}
                        </div>
                    )}

                    <div className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-lg bg-card/50 border border-white/5",
                        collapsed && "justify-center px-2"
                    )}>
                        <div className={cn(
                            "w-2 h-2 rounded-full transition-colors",
                            isLive ? "bg-green-500 animate-pulse" : "bg-red-500"
                        )} />
                        {!collapsed && (
                            <span className="text-xs font-medium text-muted-foreground flex items-center gap-2 animate-in fade-in">
                                {isLive ? "System Online" : "Disconnected"}
                                {isLive && <Wifi className="w-3 h-3 text-green-500" />}
                            </span>
                        )}
                    </div>
                </div>
            </nav>
        </aside>
    );
};

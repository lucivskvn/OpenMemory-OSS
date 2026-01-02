"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Brain, Database, Settings, Activity } from "lucide-react";

export const Sidebar = () => {
    const pathname = usePathname();

    const navItems = [
        { href: "/", label: "Dashboard", icon: LayoutDashboard },
        { href: "/graph", label: "Temporal Graph", icon: Activity },
        { href: "/memory", label: "Memory Store", icon: Database },
    ];

    return (
        <aside className="w-20 md:w-64 border-r border-white/5 bg-background flex flex-col p-4 md:p-6 gap-8 transition-all duration-300">
            <Link href="/" className="flex items-center justify-center md:justify-start gap-2 mb-4 group">
                <div className="w-10 h-10 md:w-8 md:h-8 rounded-xl md:rounded-lg bg-primary flex items-center justify-center shadow-lg shadow-primary/20 group-hover:scale-110 transition-transform">
                    <Brain className="w-6 h-6 md:w-5 md:h-5 text-white" />
                </div>
                <span className="hidden md:block font-bold text-xl tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">OpenMemory</span>
            </Link>

            <nav className="flex-1 flex flex-col gap-2">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = pathname === item.href;
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`nav-item ${isActive ? "nav-item-active" : ""} justify-center md:justify-start`}
                            title={item.label}
                        >
                            <Icon size={20} className={isActive ? "text-white" : "text-gray-400 group-hover:text-white"} />
                            <span className="hidden md:block">{item.label}</span>
                        </Link>
                    );
                })}
                <div className="nav-item mt-auto justify-center md:justify-start">
                    <Settings size={20} />
                    <span className="hidden md:block">Settings</span>
                </div>
            </nav>
        </aside>
    );
};

import { useState, useEffect, useCallback, useRef } from "react";
import { api, SystemStats, MemoryItem, ActivityItem, MaintLogEntry, GraphData, MaintenanceStatus } from "../api";
import { useMemoryStream } from "./use-stream";
import { SystemTimelineBucket } from "openmemory-js/client";

export function useDashboardData() {
    const [stats, setStats] = useState<SystemStats | null>(null);
    const [status, setStatus] = useState<MaintenanceStatus | null>(null);
    const [recent, setRecent] = useState<MemoryItem[]>([]);
    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [logs, setLogs] = useState<MaintLogEntry[]>([]);
    const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
    const [timeline, setTimeline] = useState<SystemTimelineBucket[]>([]);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (silent = false) => {
        if (!silent) setLoading(true);
        try {
            // Parallel fetch for dashboard widgets
            const [s, st, m, a, l, g, t] = await Promise.all([
                api.getStats(),
                api.getMaintenanceStatus(),
                api.getMemories(6),
                api.getActivity(20),
                api.getMaintenanceLogs(20),
                api.getGraphData(),
                api.getTimeline(24) // Last 24 hours
            ]) as [SystemStats, MaintenanceStatus, MemoryItem[], ActivityItem[], MaintLogEntry[], GraphData, SystemTimelineBucket[]];

            setStats(s);
            setStatus(st);
            setRecent(m);
            setActivity(a);
            setLogs(l);
            setGraphData(g);
            setTimeline(t);
            setError(null);
        } catch (e) {
            console.error("Failed to load dashboard data", e);
            if (!silent) setError("Connection lost. Retrying...");
        } finally {
            setLoading(false);
        }
    }, []);

    // Initial load
    useEffect(() => {
        load();
        const interval = setInterval(() => load(true), 15000); // Poll slower as we have stream
        return () => clearInterval(interval);
    }, [load]);

    // Live updates with debounce
    useEffect(() => {
        return () => {
            // Cleanup logic if needed
        };
    }, []);

    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    useMemoryStream((evt) => {
        // Optimistic or targeted updates could go here
        // For now, refresh relevant sections
        if (['memory_added', 'memory_updated', 'maintenance_op'].includes(evt.type)) {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            timeoutRef.current = setTimeout(() => {
                load(true);
            }, 500); // 500ms debounce
        }
    });

    return {
        stats,
        status,
        recent,
        activity,
        logs,
        graphData,
        timeline,
        loading,
        error,
        refresh: () => load(true)
    };
}

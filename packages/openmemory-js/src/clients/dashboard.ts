/**
 * @file dashboard.ts
 * @description sub-client for Dashboard operations.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    ActivityItem,
    TopMemory,
    DashboardTimelineEntry,
} from "../core/types/system";
import type {
    SystemStats,
    MaintenanceStats,
} from "../core/types/system";

/**
 * Dashboard Operations sub-client.
 */
export class DashboardClient extends BaseSubClient {
    /**
     * Get dashboard summary statistics.
     */
    async getStats(userId?: string, options?: { signal?: AbortSignal }): Promise<SystemStats | null> {
        const uid = userId || this.defaultUser;
        try {
            return await this.request<SystemStats>(
                `/dashboard/stats${uid ? `?userId=${uid}` : ""}`,
                { signal: options?.signal }
            );
        } catch {
            return null;
        }
    }

    /**
     * Get detailed system health metrics for the dashboard.
     */
    async getHealth(options?: { signal?: AbortSignal }): Promise<any> {
        return await this.request<any>("/dashboard/health", { signal: options?.signal });
    }

    /**
     * Get recent activity for the dashboard.
     */
    async getActivity(limit = 50, userId?: string, options?: { signal?: AbortSignal }): Promise<ActivityItem[]> {
        const uid = userId || this.defaultUser;
        const res = await this.request<{ activities: ActivityItem[] }>(
            `/dashboard/activity?limit=${limit}${uid ? `&userId=${uid}` : ""}`,
            { signal: options?.signal }
        );
        return res?.activities || [];
    }

    /**
     * Get top active memories for the dashboard.
     */
    async getTopMemories(limit = 10, userId?: string, options?: { signal?: AbortSignal }): Promise<TopMemory[]> {
        const uid = userId || this.defaultUser;
        const res = await this.request<{ memories: TopMemory[] }>(
            `/dashboard/top-memories?limit=${limit}${uid ? `&userId=${uid}` : ""}`,
            { signal: options?.signal }
        );
        return res?.memories || [];
    }

    /**
     * Get maintenance statistics for the dashboard.
     */
    async getMaintenanceStats(hours = 24, options?: { signal?: AbortSignal }): Promise<MaintenanceStats | null> {
        try {
            return await this.request<MaintenanceStats>(
                `/dashboard/maintenance?hours=${hours}`,
                { signal: options?.signal }
            );
        } catch {
            return null;
        }
    }

    /**
     * Get activity timeline for the dashboard.
     */
    async getTimeline(days = 7, userId?: string, options?: { signal?: AbortSignal }): Promise<{ timeline: DashboardTimelineEntry[] }> {
        const uid = userId || this.defaultUser;
        return await this.request<{ timeline: DashboardTimelineEntry[] }>(
            `/dashboard/sectors/timeline?hours=${days * 24}${uid ? `&userId=${uid}` : ""}`,
            { signal: options?.signal }
        );
    }

    /**
     * Get dashboard AI settings.
     */
    async getSettings(options?: { signal?: AbortSignal }): Promise<{
        openai: Record<string, unknown>;
        gemini: Record<string, unknown>;
        anthropic: Record<string, unknown>;
        ollama: Record<string, unknown>;
    }> {
        return await this.request<{
            openai: Record<string, unknown>;
            gemini: Record<string, unknown>;
            anthropic: Record<string, unknown>;
            ollama: Record<string, unknown>;
        }>("/dashboard/settings", { signal: options?.signal });
    }

    /**
     * Update dashboard AI settings.
     */
    async updateSettings(
        type: "openai" | "gemini" | "anthropic" | "ollama",
        config: Record<string, unknown>,
        options?: { signal?: AbortSignal }
    ): Promise<{ success: boolean; type: string }> {
        return await this.request<{ success: boolean; type: string }>(
            "/dashboard/settings",
            {
                method: "POST",
                body: JSON.stringify({ type, config }),
                signal: options?.signal,
            },
        );
    }
}

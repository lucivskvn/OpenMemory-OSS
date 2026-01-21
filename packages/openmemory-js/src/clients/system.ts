/**
 * @file system.ts
 * @description sub-client for System operations.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    HealthResponse,
    SystemMetrics,
    MaintenanceStatus,
    SectorsResponse,
    MaintLogEntry,
} from "../core/types/system";

/**
 * System Operations sub-client.
 */
export class SystemClient extends BaseSubClient {
    /**
     * Get system health status.
     */
    async getHealth(options?: { signal?: AbortSignal }): Promise<HealthResponse> {
        return await this.request<HealthResponse>("/api/system/health", { signal: options?.signal });
    }

    /**
     * Get system metrics (CPU, Memory, etc).
     */
    async getMetrics(options?: { signal?: AbortSignal }): Promise<{ success: boolean; metrics: SystemMetrics }> {
        return await this.request<{ success: boolean; metrics: SystemMetrics }>("/system/metrics", { signal: options?.signal });
    }

    /**
     * Get system maintenance status.
     */
    async getMaintenanceStatus(options?: { signal?: AbortSignal }): Promise<MaintenanceStatus> {
        return await this.request<MaintenanceStatus>("/api/system/maintenance", { signal: options?.signal });
    }

    /**
     * Get available memory sectors.
     */
    async getSectors(options?: { signal?: AbortSignal }): Promise<SectorsResponse> {
        return await this.request<SectorsResponse>("/api/system/sectors", { signal: options?.signal });
    }

    /**
     * Get system logs.
     */
    async getLogs(limit = 100, userId?: string, options?: { signal?: AbortSignal }): Promise<{ success: boolean; logs: MaintLogEntry[] }> {
        const params = new URLSearchParams({ limit: limit.toString() });
        if (userId) params.append("userId", userId);
        return await this.request<{ success: boolean; logs: MaintLogEntry[] }>(`/api/system/maintenance/logs?${params.toString()}`, { signal: options?.signal });
    }
}

/**
 * @file admin.ts
 * @description sub-client for Administrative and Operational tasks.
 * @audited 2026-01-19
 */

import { BaseSubClient, OpenMemoryError } from "./base";
import type {
    UserProfile,
    UserSummary,
    ApiKey,
    AuditLogParams,
    AuditLogEntry,
    AuditStats,
    Webhook,
} from "../core/types/admin";
import type { SourceRegistryEntry } from "../core/types/sources";
import type { DashboardClient } from "./dashboard";
import type { ClientInterface } from "./base";

/**
 * Administrative Operations sub-client.
 */
export class AdminOpsClient extends BaseSubClient {
    /** Dashboard Operations sub-client */
    public get dashboard(): DashboardClient {
        return (this.client as any).dashboard;
    }

    /**
     * Retrieves the profile for the current or specified user.
     * Includes metadata, role information, and summary data.
     */
    async getUserProfile(userId?: string, options?: { signal?: AbortSignal }): Promise<UserProfile> {
        const uid = userId || this.defaultUser;
        const res = await this.request<UserProfile>(
            `/users/${uid}`,
            { signal: options?.signal }
        );
        return res;
    }

    /**
     * Updates specific fields on the user profile.
     */
    async updateUserProfile(
        updates: Partial<UserProfile>,
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<UserProfile> {
        const uid = userId || this.defaultUser;
        const body: Record<string, unknown> = { ...updates };
        if (uid) body.userId = uid;

        return await this.request<UserProfile>(`/users/${uid || "me"}`, {
            method: "PATCH",
            body: JSON.stringify(body),
            signal: options?.signal,
        });
    }

    /**
     * Lists all users in the system (requires admin scope).
     */
    async listUsers(options?: { signal?: AbortSignal }): Promise<UserProfile[]> {
        const res = await this.request<{ users: UserProfile[] }>("/admin/users", {
            signal: options?.signal,
        });
        return res?.users || [];
    }

    /** Alias for listUsers for backward compatibility */
    async getUsers(options?: { signal?: AbortSignal }) { return this.listUsers(options); }

    /**
     * Retrieves a specific user by ID.
     */
    async getUser(id: string, options?: { signal?: AbortSignal }): Promise<UserProfile> {
        return await this.request<UserProfile>(`/admin/users/${id}`, { signal: options?.signal });
    }

    /**
     * Creates a new user.
     */
    async createUser(id: string, email?: string, options?: { signal?: AbortSignal }): Promise<UserProfile> {
        return await this.request<UserProfile>("/admin/users", {
            method: "POST",
            body: JSON.stringify({ id, email }),
            signal: options?.signal,
        });
    }

    /**
     * Deletes a user and all associated data.
     */
    async deleteUser(id: string, options?: { signal?: AbortSignal }): Promise<{ success: boolean }> {
        return await this.request<{ success: boolean }>(`/admin/users/${id}`, {
            method: "DELETE",
            signal: options?.signal,
        });
    }

    /**
     * Generates a new API key for the specified user and scopes.
     */
    async createApiKey(params: {
        expiresIn?: string;
        scopes?: string[];
        description?: string;
        userId?: string;
        signal?: AbortSignal;
    }): Promise<ApiKey> {
        const body: Record<string, unknown> = { ...params };
        const uid = params.userId || this.defaultUser;
        if (uid) body.userId = uid;

        return await this.request<ApiKey>(`/admin/users/${uid || "me"}/keys`, {
            method: "POST",
            body: JSON.stringify(body),
            signal: params.signal,
        });
    }

    /**
     * Lists all active API keys for a user.
     */
    async listApiKeys(userId?: string, options?: { signal?: AbortSignal }): Promise<ApiKey[]> {
        const uid = userId || this.defaultUser;
        const res = await this.request<{ keys: ApiKey[] }>(
            `/admin/users/${uid}/keys`,
            { signal: options?.signal }
        );
        return res?.keys || [];
    }

    /**
     * Revokes a specific API key.
     */
    async deleteApiKey(id: string, options?: { signal?: AbortSignal }): Promise<{ success: boolean }> {
        return await this.request<{ success: boolean }>(
            `/admin/keys/${id}`,
            {
                method: "DELETE",
                signal: options?.signal,
            },
        );
    }

    /** Alias for listApiKeys */
    async getUserKeys(userId?: string, options?: { signal?: AbortSignal }) { return this.listApiKeys(userId, options); }
    /** Alias for createApiKey */
    async createKey(userId: string, role = "user", note?: string, expires = 0, options?: { signal?: AbortSignal }) {
        return this.createApiKey({ userId, description: note, signal: options?.signal });
    }
    /** Alias for deleteApiKey */
    async deleteKey(id: string, options?: { signal?: AbortSignal }) { return this.deleteApiKey(id, options); }

    /**
     * Lists webhooks configured for a user or system-wide.
     */
    async listWebhookRegistrations(userId?: string, options?: { signal?: AbortSignal }): Promise<Webhook[]> {
        const uid = userId || this.defaultUser;
        const res = await this.request<{ webhooks: Webhook[] }>(
            `/admin/webhooks${uid ? `?userId=${uid}` : ""}`,
            { signal: options?.signal }
        );
        return res?.webhooks || [];
    }

    /**
     * Creates a snapshot of the user's data.
     * @returns A Blob containing the export data (NDJSON format).
     */
    async createSnapshot(userId?: string, options?: { signal?: AbortSignal }): Promise<Blob> {
        return this.exportData(userId, options);
    }

    /**
     * Forces a database cleanup and optimization.
     */
    async runMaintenance(options?: { signal?: AbortSignal }): Promise<{ success: boolean; message: string }> {
        return await this.request<{ success: boolean; message: string }>(
            "/admin/maintenance/run",
            {
                method: "POST",
                signal: options?.signal,
            },
        );
    }

    /**
     * Retrieves audit logs based on parameters.
     */
    async queryAuditLogs(params: AuditLogParams): Promise<{ logs: AuditLogEntry[]; stats: AuditStats }> {
        const searchParams = new URLSearchParams();
        if (params.userId) searchParams.append("userId", params.userId);
        if (params.action) searchParams.append("action", params.action);
        if (params.from) searchParams.append("from", String(params.from));
        if (params.to) searchParams.append("to", String(params.to));
        if (params.limit) searchParams.append("limit", String(params.limit));
        if (params.offset) searchParams.append("offset", String(params.offset));

        return await this.request<{ logs: AuditLogEntry[]; stats: AuditStats }>(
            `/admin/audit?${searchParams.toString()}`,
            { signal: params.signal }
        );
    }

    /** Alias for queryAuditLogs */
    async getAuditLogs(params: AuditLogParams = {}) { return this.queryAuditLogs(params); }

    /**
     * Retrieves audit statistics.
     */
    async getAuditStats(options?: { signal?: AbortSignal }): Promise<AuditStats> {
        return await this.request<AuditStats>("/admin/audit/stats", { signal: options?.signal });
    }

    /**
     * Purges audit logs older than a certain date.
     */
    async purgeAuditLogs(before?: number, options?: { signal?: AbortSignal }): Promise<{ count: number }> {
        return await this.request<{ count: number }>("/admin/audit/purge", {
            method: "POST",
            body: JSON.stringify({ before }),
            signal: options?.signal,
        });
    }

    /**
     * Triggers a manual training cycle for a specific model or user data.
     */
    async triggerTraining(params: {
        model?: string;
        dataType: "temporal" | "associative" | "all";
        userId?: string;
        signal?: AbortSignal;
    }): Promise<{ jobId: string; status: string }> {
        const uid = params.userId || this.defaultUser;
        const body: Record<string, unknown> = { ...params };
        if (uid) body.userId = uid;

        return await this.request<{ jobId: string; status: string }>(
            "/admin/intelligence/train",
            {
                method: "POST",
                body: JSON.stringify(body),
                signal: params.signal,
            },
        );
    }

    /** Alias for triggerTraining */
    async train(params: {
        model?: string;
        dataType: "temporal" | "associative" | "all";
        userId?: string;
        signal?: AbortSignal;
    }) { return this.triggerTraining(params); }

    /**
     * High-level summary of the user's cognitive state.
     */
    async getUserSummary(userId?: string, options?: { signal?: AbortSignal }): Promise<UserSummary> {
        const uid = userId || this.defaultUser;
        return await this.request<UserSummary>(
            `/admin/user/summary${uid ? `?userId=${uid}` : ""}`,
            { signal: options?.signal }
        );
    }

    /**
     * Force regenerate the user summary.
     */
    async regenerateUserSummary(userId?: string, options?: { signal?: AbortSignal }): Promise<UserSummary> {
        const uid = userId || this.defaultUser;
        return await this.request<UserSummary>("/admin/user/summary/regenerate", {
            method: "POST",
            body: JSON.stringify({ userId: uid }),
            signal: options?.signal,
        });
    }

    /**
     * Export system or user data in NDJSON format.
     */
    async exportData(userId?: string, options?: { signal?: AbortSignal }): Promise<Blob> {
        const uid = userId || this.defaultUser;
        const response = await fetch(
            `${this.client.apiBaseUrl}/admin/export${uid ? `?userId=${uid}` : ""}`,
            {
                headers: {
                    ...(this.client.token ? { Authorization: `Bearer ${this.client.token}` } : {}),
                    ...(this.client.token ? { "X-API-Key": this.client.token } : {}),
                },
                signal: options?.signal,
            },
        );

        if (!response.ok) {
            throw new OpenMemoryError("Failed to export data", response.status);
        }

        const buffer = await response.arrayBuffer();
        return new Blob([buffer], { type: "application/x-ndjson" });
    }

    /** @deprecated Use exportData */
    async exportZippedData(userId?: string, options?: { signal?: AbortSignal }) {
        return this.exportData(userId, options);
    }

    /**
     * Import system or user data.
     * Supports NDJSON (as string or Blob) or a JSON array of objects.
     */
    async importData(data: string | Blob | any[], options?: { signal?: AbortSignal }): Promise<{ success: boolean; stats: { imported: number; errors: number } }> {
        let body: string | Blob;
        let contentType = "application/x-ndjson";

        if (Array.isArray(data)) {
            body = JSON.stringify(data);
            contentType = "application/json";
        } else {
            body = data as string | Blob;
        }

        return await this.request<{ success: boolean; stats: { imported: number; errors: number } }>(
            "/admin/import",
            {
                method: "POST",
                body: body as any,
                headers: { "Content-Type": contentType },
                signal: options?.signal,
            }
        );
    }
}

/**
 * @file Audit logging service for OpenMemory.
 * Provides compliance and debugging capabilities.
 * 
 * @module core/services/audit
 */
import { randomUUID } from "crypto";
import { q } from "../db";
import { now } from "../../utils";
import { logger } from "../../utils/logger";

export interface AuditLog {
    id: string;
    userId?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
    timestamp: number;
}

export interface AuditLogParams {
    userId?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
}

export interface AuditQueryParams {
    userId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
}

/**
 * Parse metadata JSON safely with fallback.
 * @param metadataJson - Raw metadata JSON string
 * @returns Parsed object or undefined on error
 */
function parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> | undefined {
    if (!metadataJson) return undefined;
    try {
        const parsed = JSON.parse(metadataJson);
        return typeof parsed === "object" && parsed !== null ? parsed : undefined;
    } catch {
        logger.warn("[AuditService] Failed to parse metadata JSON", {
            metadataJson: metadataJson.slice(0, 100)
        });
        return undefined;
    }
}

// Database row interface for strict typing
interface AuditLogRow {
    id: string;
    userId?: string | null;
    user_id?: string | null;
    action: string;
    resourceType?: string | null;
    resource_type?: string | null;
    resourceId?: string | null;
    resource_id?: string | null;
    ipAddress?: string | null;
    ip_address?: string | null;
    userAgent?: string | null;
    user_agent?: string | null;
    metadata?: string | null;
    timestamp: number;
}

/**
 * Map database row to AuditLog interface.
 */
function mapRowToAuditLog(row: AuditLogRow): AuditLog {
    return {
        id: row.id,
        userId: (row.userId ?? row.user_id) || undefined,
        action: row.action,
        resourceType: (row.resourceType ?? row.resource_type) || "unknown", // Fallback for safety
        resourceId: (row.resourceId ?? row.resource_id) || undefined,
        ipAddress: (row.ipAddress ?? row.ip_address) || undefined,
        userAgent: (row.userAgent ?? row.user_agent) || undefined,
        metadata: parseMetadata(row.metadata),
        timestamp: row.timestamp,
    };
}

/**
 * Service for managing audit logs.
 * Uses the repository layer via q object for database operations.
 */
export class AuditService {
    private static readonly MAX_QUERY_LIMIT = 1000;
    private static readonly DEFAULT_QUERY_LIMIT = 20;

    /**
     * Log an audit event.
     * @param params - Audit event parameters.
     * @returns The created audit log entry.
     */
    async log(params: AuditLogParams): Promise<AuditLog> {
        const id = randomUUID();
        const ts = now();

        await q.auditLog.run({
            id,
            userId: params.userId ?? null,
            action: params.action,
            resourceType: params.resourceType,
            resourceId: params.resourceId ?? null,
            ipAddress: params.ipAddress ?? null,
            userAgent: params.userAgent ?? null,
            metadata: params.metadata ?? null,
            timestamp: ts,
        });

        logger.debug("[AuditService] Audit event logged", {
            id,
            action: params.action,
            resourceType: params.resourceType
        });

        return {
            id,
            userId: params.userId,
            action: params.action,
            resourceType: params.resourceType,
            resourceId: params.resourceId,
            ipAddress: params.ipAddress,
            userAgent: params.userAgent,
            metadata: params.metadata,
            timestamp: ts,
        };
    }

    /**
     * Query audit logs with filters.
     * @param params - Query parameters for filtering logs.
     * @returns Array of matching audit log entries.
     */
    async query(params: AuditQueryParams = {}): Promise<AuditLog[]> {
        // Enforce pagination bounds
        const safeLimit = Math.min(
            Math.max(1, params.limit ?? AuditService.DEFAULT_QUERY_LIMIT),
            AuditService.MAX_QUERY_LIMIT
        );

        const rows = (await q.auditQuery.all(
            params.userId ?? null,
            params.action ?? null,
            params.resourceType ?? null,
            params.startTime ?? null,
            params.endTime ?? null,
            safeLimit
        )) as AuditLogRow[];

        return rows.map(mapRowToAuditLog);
    }

    /**
     * Get recent audit logs for a specific user.
     * @param userId - The user to query logs for.
     * @param limit - Maximum number of results.
     * @returns Array of audit log entries.
     */
    async getByUser(userId: string, limit = 50): Promise<AuditLog[]> {
        return this.query({ userId, limit });
    }

    /**
     * Get recent audit logs for a specific resource.
     * @param resourceType - The resource type to query.
     * @param resourceId - The resource ID to query.
     * @param limit - Maximum number of results.
     * @returns Array of audit log entries.
     */
    async getByResource(
        resourceType: string,
        resourceId: string,
        limit = 50
    ): Promise<AuditLog[]> {
        return this.query({ resourceType, resourceId, limit });
    }
}

export const auditService = new AuditService();

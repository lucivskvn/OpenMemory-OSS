/**
 * @file Security, Auth, and Webhook types.
 */

/**
 * Access control scopes for granular permissions.
 */
export type AuthScope = "memory:read" | "memory:write" | "admin:all";

/**
 * Context of the authenticated user.
 */
export interface UserContext {
    id: string;
    scopes: AuthScope[];
}

/**
 * API Key metadata.
 */
export interface ApiKey {
    id: string;
    keyPrefix: string;
    description: string;
    scopes: string[];
    createdAt: number;
    lastUsedAt?: number;
}

/**
 * Webhook definition for event subscription.
 */
export interface Webhook {
    id: string;
    userId: string;
    url: string;
    events: string[];
    secret?: string;
    createdAt: number;
    updatedAt: number;
    lastTriggered?: number;
    retryCount?: number;
    status: "active" | "paused" | "failed";
}

export interface WebhookDeliveryResult {
    success: boolean;
    statusCode?: number;
    error?: string;
    attemptCount: number;
}

export interface WebhookCreateParams {
    id: string;
    userId: string;
    url: string;
    events: string;
    secret: string;
    createdAt: number;
}

export interface AuditLogParams {
    id?: string;
    userId?: string | null;
    action?: string;
    resourceType?: string;
    resourceId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown> | null;
    timestamp?: number;
    from?: string | number;
    to?: string | number;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
}

export interface AuditLogEntry extends AuditLogParams { }

export interface AuditStats {
    total: number;
    totalEvents: number;
    criticalEvents: number;
    byAction: Record<string, number>;
    byResourceType: Record<string, number>;
    lastEntryAt: number;
}

/**
 * User Profile information.
 */
export interface UserProfile {
    id: string;
    username: string;
    email?: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
    preferences?: Record<string, unknown>;
}

export interface UserSummary {
    userId: string | null;
    summary: string;
    lastUpdated: number;
    generatedAt: number;
}

export interface WebhookLogDeliveryParams {
    id: string;
    webhookId: string;
    eventType: string;
    payload: string;
    status: string;
    createdAt: number;
}

export interface WebhookUpdateLogParams {
    id: string;
    status: string;
    code: number;
    body: string;
    completedAt: number;
}

export interface EncryptionLogRotationParams {
    id: string;
    oldVer: number;
    newVer: number;
    status: string;
    startedAt: number;
}

export interface EncryptionUpdateStatusParams {
    id: string;
    status: string;
    completedAt: number;
    error: string | null;
}

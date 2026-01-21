/**
 * @file temporal.ts
 * @description sub-client for Temporal Knowledge Graph operations.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    TemporalFact,
    TimelineEntry,
    TemporalEdge,
    TemporalComparisonResult,
    TemporalStatsResult,
    VolatileFactsResult,
} from "../core/types/temporal";

/**
 * Temporal Graph Operations sub-client.
 */
export class TemporalClient extends BaseSubClient {
    /**
     * Adds a new temporal fact to the graph.
     * Records a fact with a validity start time (validFrom).
     * 
     * @param fact - The fact details (subject, predicate, object, etc).
     * @param userId - Optional override for user ID.
     * @returns The created fact's ID.
     */
    async addFact(
        fact: {
            subject: string;
            predicate: string;
            object: string;
            validFrom?: string | number;
            confidence?: number;
            metadata?: Record<string, unknown>;
        },
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<{ id: string } & Partial<TemporalFact>> {
        const body: Record<string, unknown> = { ...fact };
        const uid = userId || this.defaultUser;
        if (uid) body.userId = uid;

        const res = await this.request<{ id: string } & Partial<TemporalFact>>(
            "/temporal/fact",
            {
                method: "POST",
                body: JSON.stringify(body),
                signal: options?.signal,
            },
        );
        if (!res) throw new Error("Failed to add fact: Empty response");
        return res;
    }

    /**
     * Updates an existing temporal fact.
     * Allows modifying confidence or metadata without creating a new fact version.
     * 
     * @param id - The ID of the fact to update.
     * @param updates - Fields to update (confidence, metadata).
     * @returns Confirmation object.
     */
    async updateFact(
        id: string,
        updates: {
            confidence?: number;
            metadata?: Record<string, unknown>;
        },
        options?: { signal?: AbortSignal }
    ): Promise<{ id: string; message: string }> {
        const body: Record<string, unknown> = { ...updates };
        const res = await this.request<{ id: string; message: string }>(
            `/temporal/fact/${id}`,
            {
                method: "PATCH",
                body: JSON.stringify(body),
                signal: options?.signal,
            },
        );
        return res;
    }

    /**
     * Invalidates (logically deletes) a temporal fact.
     * Sets the validTo timestamp, effectively closing the fact's validity period.
     * 
     * @param id - The ID of the fact to invalidate.
     * @param validTo - The timestamp when the fact ceased to be true (default: now).
     * @returns Confirmation object.
     */
    async deleteFact(
        id: string,
        validTo?: string | number,
        options?: { signal?: AbortSignal }
    ): Promise<{ id: string; validTo: string }> {
        const body: Record<string, unknown> = {};
        if (validTo) body.validTo = validTo;

        const res = await this.request<{ id: string; validTo: string }>(
            `/temporal/fact/${id}`,
            {
                method: "DELETE",
                body: JSON.stringify(body),
                signal: options?.signal,
            },
        );
        return res;
    }

    /**
     * Retrieves temporal facts matching specific criteria.
     * Supports filtering by subject, predicate, object, and validity time.
     * 
     * @param query - Filter criteria.
     * @returns Array of matching TemporalFact objects.
     */
    async getFacts(query: {
        subject?: string;
        predicate?: string;
        object?: string;
        at?: string | number;
        minConfidence?: number;
        signal?: AbortSignal;
        userId?: string;
    }): Promise<TemporalFact[]> {
        const params = new URLSearchParams();
        if (query.subject) params.append("subject", query.subject);
        if (query.predicate) params.append("predicate", query.predicate);
        if (query.object) params.append("object", query.object);
        if (query.at) params.append("at", String(query.at));
        if (query.minConfidence)
            params.append("minConfidence", String(query.minConfidence));

        const uid = query.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ facts: TemporalFact[] }>(
            `/temporal/fact?${params.toString()}`,
            { signal: query.signal }
        );
        return res?.facts || [];
    }

    /**
     * Searches for temporal facts using a pattern matching approach.
     * Useful for finding facts when exact subject/object is unknown.
     * 
     * @param pattern - The string pattern to search for.
     * @param type - Which field to search (subject, predicate, object, or all).
     * @param limit - Max results (default 100).
     * @returns Array of matching facts.
     */
    async searchFacts(
        pattern: string,
        type: "subject" | "predicate" | "object" | "all" = "all",
        limit = 100,
        options?: { signal?: AbortSignal; userId?: string }
    ): Promise<TemporalFact[]> {
        const params = new URLSearchParams({
            pattern,
            type,
            limit: limit.toString(),
        });
        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ facts: TemporalFact[] }>(
            `/temporal/search?${params.toString()}`,
            { signal: options?.signal }
        );
        return res?.facts || [];
    }

    /**
     * Retrieves the chronological timeline of facts for a specific entity.
     * 
     * @param subject - The entity ID or name (subject).
     * @param predicate - (Optional) Filter by specific predicate/relationship.
     * @returns Chronological list of timeline entries.
     */
    async getTimeline(
        subject: string,
        predicate?: string,
        options?: { signal?: AbortSignal; userId?: string }
    ): Promise<TimelineEntry[]> {
        const params = new URLSearchParams({ subject });
        if (predicate) params.append("predicate", predicate);
        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ timeline: TimelineEntry[] }>(
            `/temporal/timeline?${params.toString()}`,
            { signal: options?.signal }
        );
        return res?.timeline || [];
    }

    /**
     * Adds a directed edge between two entities in the temporal graph.
     * Represents a relationship valid from a specific time.
     * 
     * @param edge - Edge details (source, target, relation, weight).
     * @param userId - Optional user ID override.
     * @returns The created edge ID.
     */
    async addEdge(
        edge: {
            sourceId: string;
            targetId: string;
            relationType: string;
            validFrom?: string | number;
            weight?: number;
            metadata?: Record<string, unknown>;
        },
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<{ id: string; ok: boolean }> {
        const body: Record<string, unknown> = { ...edge };
        const uid = userId || this.defaultUser;
        if (uid) body.userId = uid;

        const res = await this.request<{ id: string; ok: boolean }>(
            "/temporal/edge",
            {
                method: "POST",
                body: JSON.stringify(body),
                signal: options?.signal,
            },
        );
        if (!res) throw new Error("Failed to add edge: Empty response");
        return res;
    }

    /**
     * Updates an existing temporal edge.
     * Allows modifying weight or metadata.
     * 
     * @param id - The ID of the edge to update.
     * @param updates - Fields to update (weight, metadata).
     * @returns Confirmation object.
     */
    async updateEdge(
        id: string,
        updates: {
            weight?: number;
            metadata?: Record<string, unknown>;
        },
        options?: { signal?: AbortSignal }
    ): Promise<{ id: string; message: string }> {
        const body: Record<string, unknown> = { ...updates };
        const res = await this.request<{ id: string; message: string }>(
            `/temporal/edge/${id}`,
            {
                method: "PATCH",
                body: JSON.stringify(body),
                signal: options?.signal,
            },
        );
        return res;
    }

    /**
     * Invalidates (deletes) a temporal edge.
     * 
     * @param id - The ID of the edge to remove.
     * @param validTo - (Optional) Timestamp when the edge ceased to exist.
     * @returns Confirmation object.
     */
    async deleteEdge(
        id: string,
        validTo?: string | number,
        options?: { signal?: AbortSignal }
    ): Promise<{ id: string; validTo: string }> {
        const body: Record<string, unknown> = {};
        if (validTo) body.validTo = validTo;

        const res = await this.request<{ id: string; validTo: string }>(
            `/temporal/edge/${id}`,
            {
                method: "DELETE",
                body: JSON.stringify(body),
                signal: options?.signal,
            },
        );
        return res;
    }

    /**
     * Retrieves temporal edges matching specific criteria.
     * 
     * @param query - Filter by source, target, relation, time.
     * @returns Array of matching TemporalEdge objects.
     */
    async getEdges(query: {
        sourceId?: string;
        targetId?: string;
        relationType?: string;
        at?: string | number;
        limit?: number;
        offset?: number;
        signal?: AbortSignal;
        userId?: string;
    }): Promise<TemporalEdge[]> {
        const params = new URLSearchParams();
        if (query.sourceId) params.append("sourceId", query.sourceId);
        if (query.targetId) params.append("targetId", query.targetId);
        if (query.relationType)
            params.append("relationType", query.relationType);
        if (query.at) params.append("at", String(query.at));
        if (query.limit) params.append("limit", String(query.limit));
        if (query.offset) params.append("offset", String(query.offset));

        const uid = query.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ edges: TemporalEdge[] }>(
            `/temporal/edge?${params.toString()}`,
            { signal: query.signal }
        );
        return res?.edges || [];
    }

    /**
     * Retrieves the current valid fact for a subject/predicate.
     * 
     * @param subject - The subject entity.
     * @param predicate - The relationship/predicate.
     * @param at - (Optional) Point in time to check.
     * @returns The active fact or null.
     */
    async getCurrentFact(
        subject: string,
        predicate: string,
        at?: string | number,
        options?: { signal?: AbortSignal; userId?: string }
    ): Promise<TemporalFact | null> {
        const params = new URLSearchParams({ subject, predicate });
        if (at) params.append("at", String(at));

        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ fact: TemporalFact }>(
            `/temporal/fact/current?${params.toString()}`,
            { signal: options?.signal }
        );
        return res?.fact || null;
    }

    /**
     * Get history of a predicate.
     */
    async getPredicateHistory(
        predicate: string,
        from?: number | string,
        to?: number | string,
        options?: { signal?: AbortSignal; userId?: string }
    ): Promise<TimelineEntry[]> {
        const params = new URLSearchParams({ predicate });
        if (from) params.append("from", String(from));
        if (to) params.append("to", String(to));

        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ timeline: TimelineEntry[] }>(
            `/temporal/history/predicate?${params.toString()}`,
            { signal: options?.signal }
        );
        return res?.timeline || [];
    }

    /**
     * Retrieves all active facts for a specific subject at a given point in time.
     * 
     * @param subject - The subject to query (e.g., "John Doe").
     * @param at - Target timestamp or "now".
     * @param includeHistorical - Whether to include facts that are no longer valid.
     * @returns Array of matching temporal facts.
     */
    async getSubjectFacts(
        subject: string,
        at?: number | string,
        includeHistorical = false,
        options?: { signal?: AbortSignal; userId?: string }
    ): Promise<TemporalFact[]> {
        const params = new URLSearchParams();
        if (at) params.append("at", String(at));
        if (includeHistorical) params.append("includeHistorical", "true");

        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{ facts: TemporalFact[] }>(
            `/temporal/subject/${encodeURIComponent(subject)}?${params.toString()}`,
            { signal: options?.signal }
        );
        return res?.facts || [];
    }

    /**
     * Compares the state of facts for a subject between two distinct timestamps.
     * Identifies added, removed, and changed facts.
     * 
     * @param subject - The subject to compare.
     * @param time1 - The first (older) timestamp.
     * @param time2 - The second (newer) timestamp.
     * @returns A comparison result including diffs.
     */
    async compareFacts(
        subject: string,
        time1: number | string,
        time2: number | string,
        options?: { signal?: AbortSignal; userId?: string }
    ): Promise<TemporalComparisonResult> {
        const params = new URLSearchParams({
            subject,
            time1: String(time1),
            time2: String(time2),
        });
        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);
        return await this.request<TemporalComparisonResult>(
            `/temporal/compare?${params.toString()}`,
            { signal: options?.signal }
        );
    }

    /**
     * Get temporal statistics.
     */
    async getStats(options?: { signal?: AbortSignal; userId?: string }): Promise<TemporalStatsResult> {
        const params = new URLSearchParams();
        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);
        return await this.request<TemporalStatsResult>(
            `/temporal/stats?${params.toString()}`,
            { signal: options?.signal }
        );
    }

    /**
     * Apply confidence decay globally.
     */
    async applyDecay(
        decayRate = 0.01,
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<{ factsUpdated: number }> {
        const body: Record<string, unknown> = { decayRate };
        const uid = userId || this.defaultUser;
        if (uid) body.userId = uid;

        return await this.request("/temporal/decay", {
            method: "POST",
            body: JSON.stringify(body),
            signal: options?.signal,
        });
    }

    /**
     * Get most volatile facts (frequent changes).
     */
    async getVolatileFacts(
        subject?: string,
        limit = 10,
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<VolatileFactsResult> {
        const params = new URLSearchParams();
        if (subject) params.append("subject", subject);
        params.append("limit", String(limit));

        const uid = userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<VolatileFactsResult>(
            `/temporal/volatile?${params.toString()}`,
            { signal: options?.signal }
        );
        return res;
    }

    /**
     * Retrieves the graph context (neighborhood) for a specific fact.
     * Useful for traversing the knowledge graph.
     * 
     * @param factId - The unique identifier of the center fact.
     * @param options - Relation type and point-in-time filters.
     * @returns Array of related facts and their relationship weights.
     */
    async getGraphContext(
        factId: string,
        options?: { relationType?: string; at?: string | number; userId?: string; signal?: AbortSignal },
    ): Promise<Array<{ fact: TemporalFact; relation: string; weight: number }>> {
        const params = new URLSearchParams({ factId });
        if (options?.relationType) params.append("relationType", options.relationType);
        if (options?.at) params.append("at", String(options.at));
        const uid = options?.userId || this.defaultUser;
        if (uid) params.append("userId", uid);

        const res = await this.request<{
            results: Array<{ fact: TemporalFact; relation: string; weight: number }>;
        }>(`/temporal/graph-context?${params.toString()}`, { signal: options?.signal });
        return res?.results || [];
    }
}

/**
 * @file sources.ts
 * @description sub-client for Knowledge Ingestion and Data Sources.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    IngestRequest,
    IngestUrlRequest,
    IngestionResult,
    SourceListResult,
    SourceRegistryEntry,
    IngestSourceResult,
} from "../core/types/sources";

/**
 * Knowledge Ingestion and Data Sources sub-client.
 */
export class SourcesClient extends BaseSubClient {
    /**
     * Manually ingests data (text, file, etc) into memory.
     */
    async ingest(params: IngestRequest & { userId?: string }): Promise<IngestionResult> {
        const body = { ...params };
        if (body.userId === undefined) body.userId = this.defaultUser;
        return await this.request<IngestionResult>("/memory/ingest", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    /**
     * Ingests content from a public URL.
     */
    async ingestUrl(params: IngestUrlRequest & { userId?: string }): Promise<IngestionResult> {
        const body = { ...params };
        if (body.userId === undefined) body.userId = this.defaultUser;
        return await this.request<IngestionResult>("/memory/ingest/url", {
            method: "POST",
            body: JSON.stringify(body),
        });
    }

    /**
     * Lists all registered external data sources.
     */
    async listSources(userId?: string): Promise<SourceListResult> {
        const uid = userId || this.defaultUser;
        return await this.request<SourceListResult>(
            `/sources${uid ? `?userId=${uid}` : ""}`,
        );
    }

    /**
     * Registers or configures an external data source connector.
     */
    async configureSource(params: {
        type: string;
        config: Record<string, any>;
        userId?: string;
    }): Promise<SourceRegistryEntry> {
        const uid = params.userId || this.defaultUser;
        return await this.request<SourceRegistryEntry>(`/source-configs/${params.type}`, {
            method: "POST",
            body: JSON.stringify({ ...params, userId: uid }),
        });
    }

    /**
     * Triggers a crawl/sync for a specific data source.
     * @param sourceId - The source identifier (e.g., "github", "notion")
     * @param userId - Optional admin override for user ID
     * @param options - Optional request options (signal for abort)
     */
    async syncSource(sourceId: string, userId?: string, options?: { signal?: AbortSignal }): Promise<IngestSourceResult> {
        const uid = userId || this.defaultUser;
        return await this.request<IngestSourceResult>(
            `/sources/${sourceId}/ingest`,
            {
                method: "POST",
                body: JSON.stringify({ userId: uid }),
                signal: options?.signal,
            },
        );
    }
}

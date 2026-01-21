/**
 * @file Knowledge Ingestion and Data Source types.
 */

/**
 * Knowledge ingestion request.
 */
export interface IngestRequest {
    source: "file" | "link" | "connector" | string;
    contentType: string;
    data: string | Uint8Array;
    metadata?: Record<string, unknown>;
    tags?: string[];
    config?: IngestionConfig;
    userId?: string | null;
}

/**
 * Webpage/URL-specific ingestion request.
 */
export interface IngestUrlRequest {
    url: string;
    metadata?: Record<string, unknown>;
    tags?: string[];
    config?: IngestionConfig;
    userId?: string | null;
}

/**
 * Configuration for data extraction.
 */
export interface ExtractionConfig {
    maxSizeBytes?: number;
    selectors?: string[];
    excludeSelectors?: string[];
    waitForSelector?: string;
    userAgent?: string;
}

/**
 * Configuration for document and URL ingestion.
 */
export interface IngestionConfig extends ExtractionConfig {
    forceRoot?: boolean;
    secSz?: number;
    lgThresh?: number;
    fastSummarize?: boolean;
}

/**
 * Core text extraction result.
 */
export interface ExtractionResult {
    text: string;
    metadata: {
        contentType: string;
        charCount: number;
        estimatedTokens: number;
        extractionMethod: string;
        [key: string]: unknown;
    };
}

/**
 * Result of the ingestion process.
 */
export interface IngestionResult {
    rootMemoryId: string;
    childCount: number;
    totalTokens: number;
    strategy: "single" | "root-child";
    extraction: Record<string, unknown>;
}

export interface SourceListResult {
    sources: string[];
    usage: Record<string, number>;
}

export interface IngestSourceResult {
    success: boolean;
    result: unknown;
}

/**
 * Entry in the data source registry.
 */
export interface SourceRegistryEntry {
    id: string;
    type: string;
    config: Record<string, unknown>;
    userId: string | null;
    createdAt: number;
    updatedAt: number;
}

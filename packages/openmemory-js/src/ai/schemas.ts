/**
 * @file schemas.ts
 * @description Shared Zod schemas for AI and MCP tools.
 * @audited 2026-01-19
 */
import { z } from "zod";

// --- Enums ---

export const sectorEnum = z.enum([
    "episodic",
    "semantic",
    "procedural",
    "emotional",
    "reflective",
] as const);

// --- Core Schemas ---

/**
 * Maximum content length for memory storage (500KB).
 * This prevents oversized payloads while allowing substantial text content.
 */
export const MAX_CONTENT_LENGTH = 500_000;

export const SearchSchema = z.object({
    query: z
        .string()
        .min(1, "query text is required")
        .describe("Free-form search text (e.g., 'What did we discuss about the project architecture?')"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(5)
        .describe("Max number of results"),
    userId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Isolate results to a specific user identifier"),
    sectors: z
        .array(sectorEnum)
        .optional()
        .describe("Restrict search to specific sectors (e.g., ['semantic', 'procedural'])"),
    minSalience: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum salience threshold (0.0=all, 1.0=very important)"),
});

export const StoreSchema = z.object({
    content: z
        .string()
        .min(1, "content is required")
        .max(
            MAX_CONTENT_LENGTH,
            `content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`,
        )
        .describe("Raw memory text to store (max 500KB)"),
    tags: z
        .array(z.string())
        .optional()
        .default([])
        .describe("Tags for categorization"),
    metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe("Arbitrary metadata blob"),
    userId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Associate the memory with a specific user identifier"),
    salience: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Initial importance score (0.0 to 1.0)"),
    decayLambda: z
        .number()
        .min(0)
        .optional()
        .describe("Custom decay rate constant"),
});

// --- Temporal Schemas ---

export const TemporalFactSchema = z.object({
    subject: z
        .string()
        .min(1)
        .describe("The subject of the fact (e.g., 'Company A', 'Alice')"),
    predicate: z
        .string()
        .min(1)
        .describe("The relationship (e.g., 'headquarters_in', 'works_at')"),
    object: z
        .string()
        .min(1)
        .describe("The object of the fact (e.g., 'San Francisco', 'Google')"),
    validFrom: z
        .string()
        .optional()
        .describe("ISO date string for when the fact became true (e.g., '2024-01-15')"),
    confidence: z
        .number()
        .min(0)
        .max(1)
        .default(1.0)
        .describe("Confidence score (0.0 to 1.0)"),
    userId: z.string().optional().describe("Owner of this fact"),
    metadata: z
        .record(z.string(), z.any())
        .optional()
        .describe("Additional structured data (e.g., source citation)"),
});

export const TemporalQuerySchema = z.object({
    subject: z.string().optional().describe("Filter facts by subject entity (e.g., 'Alice')"),
    predicate: z
        .string()
        .optional()
        .describe("Filter facts by predicate/relationship type (e.g., 'works_at')"),
    object: z.string().optional().describe("Filter facts by object entity (e.g., 'Google')"),
    at: z
        .string()
        .optional()
        .describe("Query state at this ISO date-time (e.g., '2023-12-01T12:00:00Z', defaults to now)"),
    userId: z.string().optional().describe("Filter facts by owner"),
});

export const TemporalSearchSchema = z.object({
    query: z.string().min(1).describe("Keyword to search for in facts"),
    limit: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe("Maximum number of results to return"),
    userId: z.string().optional().describe("Filter facts by owner"),
});

export const TemporalCompareSchema = z.object({
    subject: z.string().min(1).describe("Subject to compare"),
    time1: z.string().optional().describe("ISO date string for first point in time"),
    time2: z.string().optional().describe("ISO date string for second point in time"),
    userId: z.string().optional().describe("User context"),
});

export const TemporalDecaySchema = z.object({
    decayRate: z.number().min(0).max(1).optional().describe("Custom decay rate (0.0 to 1.0)"),
    userId: z.string().optional().describe("User context"),
});

export const TemporalStatsSchema = z.object({
    userId: z.string().optional().describe("User context"),
});

export const TemporalEdgeCreateSchema = z.object({
    sourceId: z.string().min(1).describe("ID of the source memory"),
    targetId: z.string().min(1).describe("ID of the target memory"),
    relationType: z.string().min(1).describe("Type of relationship (e.g., 'references', 'contradicts')"),
    weight: z.number().min(0).max(1).optional().default(1.0).describe("Strength of the relationship (0-1)"),
    validFrom: z.string().optional().describe("ISO date string for when this edge became valid"),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

export const TemporalEdgeUpdateSchema = z.object({
    edgeId: z.string().min(1).describe("ID of the edge to update"),
    weight: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

export const TemporalEdgeQuerySchema = z.object({
    sourceId: z.string().optional().describe("Filter by source memory ID"),
    targetId: z.string().optional().describe("Filter by target memory ID"),
    relationType: z.string().optional().describe("Filter by relationship type"),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).default(0),
    userId: z.string().optional(),
    at: z.string().optional().describe("ISO date string"),
});

export const StoreNodeSchema = z.object({
    node: z
        .string()
        .min(1)
        .describe("The LangGraph node name (e.g., 'plan', 'reflect')"),
    content: z.string().min(1).describe("Content to store"),
    namespace: z.string().optional().default("default"),
    graphId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    reflective: z.boolean().optional(),
    memoryId: z.string().optional().describe("ID of an existing memory to link"),
    userId: z.string().optional(),
});

export const RetrieveNodeMemsSchema = z.object({
    node: z.string().min(1).describe("Node name"),
    namespace: z.string().optional().default("default"),
    query: z.string().optional().describe("Optional search query within node memories"),
    limit: z.number().int().min(1).default(10),
    userId: z.string().optional(),
});

export const GetGraphContextSchema = z.object({
    namespace: z.string().optional().default("default"),
    graphId: z.string().optional(),
    limit: z.number().int().min(1).default(20),
    userId: z.string().optional(),
});

// --- Derived Types ---

export type SearchParams = z.infer<typeof SearchSchema>;
export type StoreParams = z.infer<typeof StoreSchema>;
export type TemporalFactParams = z.infer<typeof TemporalFactSchema>;
export type TemporalQueryParams = z.infer<typeof TemporalQuerySchema>;
export type TemporalSearchParams = z.infer<typeof TemporalSearchSchema>;

export const IngestSchema = z.object({
    data: z.any().describe("Raw content or binary data to ingest"),
    contentType: z.string().min(1).default("text/plain").describe("MIME type (e.g., text/plain, text/markdown)"),
    tags: z.array(z.string()).optional().default([]).describe("Tags to apply"),
    metadata: z.record(z.string(), z.any()).optional().default({}),
    userId: z.string().optional().describe("User context"),
    config: z.record(z.string(), z.any()).optional().describe("Ingestion config (e.g. { lgThresh: 5000 })"),
});

export type IngestParams = z.infer<typeof IngestSchema>;


export const AuditQuerySchema = z.object({
    userId: z.string().optional(),
    action: z.string().optional(),
    resourceType: z.string().optional(),
    resourceId: z.string().optional(),
    startTime: z.coerce.number().optional(),
    endTime: z.coerce.number().optional(),
    limit: z.coerce.number().max(100).default(20),
});

export const WebhookCreateSchema = z.object({
    url: z.string().url().describe("Webhook URL"),
    events: z.array(z.string()).describe("Events to subscribe to: memory.created, memory.updated, memory.deleted"),
    secret: z.string().min(8).describe("Secret for signature verification"),
    userId: z.string().optional(),
});

export const WebhookListSchema = z.object({
    userId: z.string().optional(),
    limit: z.number().max(100).default(20),
});

export const WebhookDeleteSchema = z.object({
    id: z.string().min(1),
    userId: z.string().optional(),
});

export const WebhookTestSchema = z.object({
    id: z.string().min(1),
    userId: z.string().optional(),
});

export const MetricsQuerySchema = z.object({
    userId: z.string().optional(),
    metricType: z.enum(["request_rate", "error_rate", "latency", "memory_usage", "cache_hit_rate"]),
    timeRange: z.string().describe("1h, 24h, 7d, 30d").optional(),
});

export const BulkDeleteSchema = z.object({
    memoryIds: z.array(z.string()).min(1).max(1000),
    userId: z.string().optional(),
});

export const BulkUpdateSchema = z.object({
    memoryIds: z.array(z.string()).min(1).max(1000),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

export const HealthCheckSchema = z.object({
    includeDependencies: z.boolean().default(true),
});

export const IngestUrlSchema = z.object({
    url: z.string().url().refine(u => u.startsWith("http://") || u.startsWith("https://"), { message: "Only HTTP/HTTPS URLs are allowed" }).describe("URL to ingest content from (HTTP/HTTPS only)"),
    tags: z.array(z.string()).optional().default([]).describe("Tags to apply to ingested memory"),
    userId: z.string().optional().describe("User context"),
    metadata: z.record(z.string(), z.any()).optional().default({}),
    config: z.record(z.string(), z.any()).optional().describe("Ingestion config (e.g. { lgThresh: 5000 })"),
});

export const ReinforceSchema = z.object({
    id: z.string().min(1).describe("Memory identifier to reinforce"),
    boost: z.number().min(0.01).max(1).default(0.1).describe("Salience boost amount (default 0.1)"),
    userId: z.string().optional().describe("Optional user context for authorization"),
});

// Re-export for convenience if needed, or use named exports

export const OpenMemoryListSchema = z.object({
    limit: z.number().int().min(1).max(50).default(10).describe("Number of memories to return"),
    sector: sectorEnum.optional().describe("Optionally limit to a sector"),
    userId: z.string().trim().min(1).optional().describe("Restrict results to a specific user identifier"),
});

export const OpenMemoryGetSchema = z.object({
    id: z.string().min(1).describe("Memory identifier to load"),
    includeVectors: z.boolean().default(false).describe("Include sector vector metadata"),
    userId: z.string().trim().min(1).optional().describe("Validate ownership against a specific user identifier"),
});

export const OpenMemoryUpdateSchema = z.object({
    id: z.string().min(1).describe("Memory identifier to update"),
    content: z.string().optional().describe("New content text"),
    tags: z.array(z.string()).optional().describe("New tags"),
    metadata: z.record(z.string(), z.any()).optional().describe("Metadata updates"),
    userId: z.string().optional().describe("User context for ownership validation"),
});

export const OpenMemoryDeleteSchema = z.object({
    id: z.string().min(1).describe("Memory identifier to delete"),
    userId: z.string().optional().describe("User context for ownership validation"),
});

export const OpenMemoryIngestContentSchema = z.object({
    content: z.string().min(1).describe("Text content to ingest"),
    contentType: z.string().min(1).default("text/plain").describe("MIME type"),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    config: z.record(z.string(), z.any()).optional(),
    userId: z.string().optional(),
});

export const TemporalFactUpdateSchema = z.object({
    factId: z.string().min(1).describe("Fact ID to update"),
    confidence: z.number().optional().describe("New confidence score (0-1)"),
    metadata: z.record(z.string(), z.any()).optional().describe("Metadata updates"),
    userId: z.string().optional(),
});

export const TemporalTimelineSchema = z.object({
    subject: z.string().min(1).describe("Subject to get timeline for"),
    userId: z.string().optional(),
});

// Duplicate definitions removed

export const IdeContextSchema = z.object({
    file: z.string().min(1).describe("The file path currently open in the IDE"),
    line: z.number().int().min(0).default(0).describe("Current cursor line number"),
    content: z.string().describe("Relevant surrounding code content"),
    userId: z.string().optional().describe("User context identifier"),
    sessionId: z.string().optional().describe("Optional IDE session ID for graph context linking"),
    limit: z.number().int().min(1).max(50).default(5).describe("Max context items to return"),
});

export const IdePatternsSchema = z.object({
    activeFiles: z.array(z.string()).optional().describe("List of files currently active in the workspace"),
    userId: z.string().optional().describe("User context identifier"),
    sessionId: z.string().optional().describe("Optional IDE session ID"),
});

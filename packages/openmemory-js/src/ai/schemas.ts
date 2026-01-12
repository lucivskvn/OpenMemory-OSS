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
        .describe("Free-form search text"),
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
        .describe("Restrict search to specific sectors"),
    minSalience: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum salience threshold"),
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
});

// --- Temporal Schemas ---

export const TemporalFactSchema = z.object({
    subject: z
        .string()
        .min(1)
        .describe("The subject of the fact (e.g., 'Company A')"),
    predicate: z
        .string()
        .min(1)
        .describe("The relationship (e.g., 'headquarters_in')"),
    object: z
        .string()
        .min(1)
        .describe("The object of the fact (e.g., 'San Francisco')"),
    validFrom: z
        .string()
        .optional()
        .describe("ISO date string for when the fact became true"),
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
        .describe("Additional structured data"),
});

export const TemporalQuerySchema = z.object({
    subject: z.string().optional().describe("Filter facts by subject entity"),
    predicate: z
        .string()
        .optional()
        .describe("Filter facts by predicate/relationship type"),
    object: z.string().optional().describe("Filter facts by object entity"),
    at: z
        .string()
        .optional()
        .describe("Query state at this ISO date-time (defaults to now)"),
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

// --- Derived Types ---

export type SearchParams = z.infer<typeof SearchSchema>;
export type StoreParams = z.infer<typeof StoreSchema>;
export type TemporalFactParams = z.infer<typeof TemporalFactSchema>;
export type TemporalQueryParams = z.infer<typeof TemporalQuerySchema>;
export type TemporalSearchParams = z.infer<typeof TemporalSearchSchema>;

export const IngestSchema = z.object({
    content: z.string().min(1).describe("Text content to ingest"),
    contentType: z.string().min(1).default("text/plain").describe("MIME type (e.g., text/plain, text/markdown)"),
    tags: z.array(z.string()).optional().default([]).describe("Tags to apply"),
    metadata: z.record(z.string(), z.any()).optional().default({}),
    userId: z.string().optional().describe("User context"),
    config: z.record(z.string(), z.any()).optional().describe("Ingestion config (e.g. { lgThresh: 5000 })"),
});

export type IngestParams = z.infer<typeof IngestSchema>;

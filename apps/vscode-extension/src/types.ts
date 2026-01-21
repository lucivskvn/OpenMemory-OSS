import { MemoryItem, IdePattern } from 'openmemory-js/client';

export type Memory = MemoryItem;
export type Pattern = IdePattern;

/**
 * Data structure for IDE events sent to the backend.
 * Used when tracking file saves, edits, and other coding activities.
 */
export interface EventData {
    /** Type of event (e.g., 'save', 'edit', 'open') */
    eventType: string;
    /** Absolute path to the file */
    filePath: string;
    /** Language identifier (e.g., 'typescript', 'python') */
    language: string;
    /** Content or diff of the change */
    content?: string;
    /** Additional event metadata */
    metadata?: {
        lineCount?: number;
        isDirty?: boolean;
        workspaceFolder?: string;
        /** Suggested memory sectors for classification */
        sectorHints?: string[];
        [key: string]: unknown;
    };
    /** ISO timestamp of the event */
    timestamp?: string;
}

/**
 * Error response structure from the OpenMemory API.
 */
export interface ApiErrorResponse {
    error: {
        /** Error code identifier */
        code: string;
        /** Human-readable error message */
        message: string;
        /** Additional error context */
        details?: Record<string, unknown>;
    };
}

/**
 * Local type for display purposes, avoiding full MemoryItem mocking.
 */
export interface DisplayMemory {
    id: string;
    content: string;
    salience?: number;
    primarySector?: string;
    metadata?: Record<string, unknown>;
}

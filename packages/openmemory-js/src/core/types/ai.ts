/**
 * @file Agent, LangGraph, and IDE Task types.
 */

import { MemoryItem, IdePattern } from "./memory";
import type { IdeSuggestionPayload, IdeSessionPayload, MemoryAddedPayload } from "./aiEvents";

export type { IdeSuggestionPayload, IdeSessionPayload, MemoryAddedPayload };

/**
 * Request for storing memory in a LangGraph/dynamic agent context.
 */
export interface LgmStoreRequest {
    node: string;
    content?: string;
    memoryId?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    namespace?: string;
    graphId?: string;
    reflective?: boolean;
    userId?: string | null;
}

export interface LgmRetrieveRequest {
    node: string;
    query?: string;
    namespace?: string;
    graphId?: string;
    limit?: number;
    includeMetadata?: boolean;
    userId?: string | null;
}

export interface LgmContextRequest {
    node?: string;
    graphId?: string;
    namespace?: string;
    userId?: string | null;
    limit?: number;
}

export interface LgmReflectionRequest {
    graphId?: string;
    node: string;
    content?: string;
    contextIds?: string[];
    namespace?: string;
    userId?: string | null;
    depth?: "shallow" | "deep";
}

export interface LgConfig {
    success: boolean;
    config: {
        nodes: string[];
        edges: { source: string; target: string }[];
    };
}

export interface LgStoreResult {
    success: boolean;
    memoryId: string;
    node: string;
    memory?: MemoryItem | null;
}

export interface LgRetrieveResult {
    success: boolean;
    memories: MemoryItem[];
}

export interface LgNodeContext {
    node: string;
    items: MemoryItem[];
}

export interface LgContextResult {
    success: boolean;
    context: string;
    sources: string[];
    nodes?: LgNodeContext[];
}

export interface LgReflectResult {
    success: boolean;
    reflectionId: string;
    insights: string[];
    chunks?: number;
}

/**
 * System event captured from IDE extensions.
 */
export interface IdeEventRequest {
    event:
    | "edit"
    | "open"
    | "close"
    | "save"
    | "refactor"
    | "comment"
    | "pattern_detected"
    | "api_call"
    | "definition"
    | "reflection";
    file?: string;
    snippet?: string;
    comment?: string;
    metadata: {
        project?: string;
        lang?: string;
        user?: string;
        timestamp?: number;
        [key: string]: unknown;
    };
    sessionId?: string;
}

export interface IdeSessionResult {
    sessionId: string;
    memoryId: string;
    startedAt: number;
}

export interface IdeEventResult {
    success: boolean;
    memoryId?: string;
    primarySector?: string;
}

export interface IdeContextItem {
    memoryId: string;
    content: string;
    primarySector: string;
    sectors: string[];
    score: number;
    salience: number;
    lastSeenAt: number;
    path: string[];
}

export interface IdeContextResult {
    success: boolean;
    context: IdeContextItem[];
    query: string;
}

export interface IdePatternsResult {
    success: boolean;
    sessionId: string;
    patternCount: number;
    patterns: IdePattern[];
}

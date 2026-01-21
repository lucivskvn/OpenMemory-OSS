import { EventEmitter } from "events";

import { env } from "./cfg";
import { getContext } from "./context";
import {
    IdeSessionPayload,
    IdeSuggestionPayload,
    MemoryItem,
} from "./types";
import { logger } from "../utils/logger";

// Define constants FIRST so they can be used in types
export const EVENTS = {
    MEMORY_ADDED: "memory_added",
    MEMORY_UPDATED: "memory_updated",
    MEMORY_DELETED: "memory_deleted",
    IDE_SUGGESTION: "ide_suggestion",
    IDE_SESSION_UPDATE: "ide_session_update",
    TEMPORAL_FACT_CREATED: "temporal:fact:created",
    TEMPORAL_FACT_UPDATED: "temporal:fact:updated",
    TEMPORAL_FACT_DELETED: "temporal:fact:deleted",
    TEMPORAL_EDGE_CREATED: "temporal:edge:created",
    TEMPORAL_EDGE_UPDATED: "temporal:edge:updated",
    TEMPORAL_EDGE_DELETED: "temporal:edge:deleted",
} as const;

// Define the signature of event payloads
export interface OpenMemoryEventMap {
    /**
     * Fired when a new memory (episodic, semantic, etc.) is added to the system.
     * Guaranteed to be fully hydrated with ID and primary sector.
     */
    [EVENTS.MEMORY_ADDED]: MemoryItem;

    /**
     * Fired when a memory is modified (content, tags, or metadata).
     */
    [EVENTS.MEMORY_UPDATED]: Partial<MemoryItem> & { id: string };

    /**
     * Fired when a memory is deleted.
     */
    [EVENTS.MEMORY_DELETED]: { id: string; userId?: string | null };

    /**
     * Fired when the IDE integration detects a new pattern or suggestion.
     */
    [EVENTS.IDE_SUGGESTION]: IdeSuggestionPayload;

    /**
     * Fired when an IDE session changes state (start/end).
     */
    [EVENTS.IDE_SESSION_UPDATE]: IdeSessionPayload;

    // --- Temporal Graph Events ---

    /**
     * Fired when a raw fact (Subject-Predicate-Object) is inserted.
     */
    [EVENTS.TEMPORAL_FACT_CREATED]: {
        id: string;
        userId?: string;
        subject: string;
        predicate: string;
        object: string;
        validFrom: number;
        validTo?: number | null;
        confidence: number;
        metadata?: Record<string, unknown>;
    };

    /**
     * Fired when a fact's confidence or metadata is updated.
     */
    [EVENTS.TEMPORAL_FACT_UPDATED]: {
        id: string;
        userId?: string;
        confidence?: number;
        metadata?: Record<string, unknown>;
    };

    /**
     * Fired when a fact is logically deleted or invalidated (validTo set).
     */
    [EVENTS.TEMPORAL_FACT_DELETED]: {
        id: string;
        userId?: string;
        validTo: number;
    };

    /**
     * Fired when a relationship edge is created between two concepts.
     */
    [EVENTS.TEMPORAL_EDGE_CREATED]: {
        id: string;
        userId?: string;
        sourceId: string;
        targetId: string;
        relationType: string;
        validFrom: number;
        weight: number;
        lastUpdated: number;
        metadata?: Record<string, unknown>;
    };

    /**
     * Fired when an edge's weight or metadata is updated.
     */
    [EVENTS.TEMPORAL_EDGE_UPDATED]: {
        id: string;
        userId?: string;
        weight?: number;
        lastUpdated: number;
        metadata?: Record<string, unknown>;
    };

    /**
     * Fired when an edge is invalidated.
     */
    [EVENTS.TEMPORAL_EDGE_DELETED]: {
        id: string;
        userId?: string;
        validTo: number;
    };
}

/**
 * Type-safe wrapper around EventEmitter.
 */
class TypedEventEmitter extends EventEmitter {
    constructor() {
        super();
        const maxListeners = env.eventMaxListeners || 100;
        this.setMaxListeners(maxListeners);
    }

    /**
     * Synchronously calls each of the listeners registered for the event named `eventName`.
     * Hardened to isolate listener errors and inject context metadata.
     * Catches async listener errors to prevent unhandled promise rejections.
     */
    override emit<K extends keyof OpenMemoryEventMap>(
        event: K,
        payload: OpenMemoryEventMap[K],
    ): boolean {
        const ctx = getContext();
        if (ctx?.requestId && typeof payload === "object" && payload !== null) {
            // Inject requestId into payload if not present and not frozen
            const p = payload as Record<string, unknown>;
            if (!p.requestId && !Object.isFrozen(p)) {
                try {
                    p.requestId = ctx.requestId;
                } catch (e) {
                    // Ignore mutation errors if read-only
                }
            }
        }

        // Use rawListeners to ensure we get the exact functions (including wrappers)
        // so that our custom 'once' wrappers match correctly when they call off().
        const listeners = this.rawListeners(event);
        if (listeners.length === 0) return false;

        for (const listener of listeners) {
            try {
                // Call directly. Our custom 'once' wrapper handles self-removal.
                const result = (listener as Function)(payload);

                // If the listener returns a Promise (async), we must catch rejections
                // because simple try-catch block above only catches synchronous errors.
                if (result instanceof Promise) {
                    result.catch((error: unknown) => {
                        logger.error(`[EVENTS] Async error in listener for ${String(event)}:`, {
                            error,
                            requestId: ctx?.requestId,
                        });
                    });
                }
            } catch (error) {
                logger.error(`[EVENTS] Error in listener for ${String(event)}:`, {
                    error,
                    requestId: ctx?.requestId,
                });
            }
        }
        return true;
    }

    /**
     * Adds the `listener` function to the end of the listeners array for the event named `eventName`.
     */
    override on<K extends keyof OpenMemoryEventMap>(
        event: K,
        listener: (payload: OpenMemoryEventMap[K]) => void,
    ): this {
        return super.on(event, listener);
    }

    /**
     * Adds a **one-time** `listener` function for the event named `eventName`.
     * Implements manual wrapping to ensure compatibility with our safe emit loop.
     */
    override once<K extends keyof OpenMemoryEventMap>(
        event: K,
        listener: (payload: OpenMemoryEventMap[K]) => void,
    ): this {
        const wrapper = (payload: OpenMemoryEventMap[K]) => {
            this.off(event, wrapper as any);
            listener(payload);
        };
        // Attach original listener for 'off' compatibility
        (wrapper as any).listener = listener;
        return this.on(event, wrapper as any);
    }

    /**
     * Removes the specified `listener` from the listener array for the event named `eventName`.
     */
    override off<K extends keyof OpenMemoryEventMap>(
        event: K,
        listener: (payload: OpenMemoryEventMap[K]) => void,
    ): this {
        return super.off(event, listener);
    }

    /**
     * Resets the event bus by removing all listeners for all events.
     * Useful for test isolation.
     */
    clearListeners(): void {
        this.removeAllListeners();
    }
}

/**
 * Global Event Bus for decoupling system components.
 * Enforces strict payload types for all events.
 */
export const eventBus = new TypedEventEmitter();

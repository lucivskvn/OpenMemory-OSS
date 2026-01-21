import type { IdePattern } from "./memory";

/** Base interface for all OpenMemory events */
export interface BaseEvent {
    type: string;
    timestamp: number;
}

export interface MemoryAddedPayload {
    id: string;
    primarySector: string;
    content: string;
    userId?: string | null;
    [key: string]: unknown;
}

export interface IdeSuggestionPayload {
    sessionId: string;
    count: number;
    topPattern: IdePattern;
    userId?: string;
}

export interface IdeSessionPayload {
    sessionId: string;
    status: "started" | "ended";
    projectName?: string;
    summary?: string;
    userId?: string;
}

/** Specific Event Variants */

export interface ConnectedEvent extends BaseEvent {
    type: "connected";
}

export interface HeartbeatEvent extends BaseEvent {
    type: "heartbeat";
}

export interface MemoryAddedEvent extends BaseEvent {
    type: "memory_added";
    data: MemoryAddedPayload;
}

export interface MemoryUpdatedEvent extends BaseEvent {
    type: "memory_updated";
    data: { id: string; userId?: string | null };
}

export interface IdeSuggestionEvent extends BaseEvent {
    type: "ide_suggestion";
    data: IdeSuggestionPayload;
}

export interface IdeSessionUpdateEvent extends BaseEvent {
    type: "ide_session_update";
    data: IdeSessionPayload;
}

export interface TemporalFactCreatedEvent extends BaseEvent {
    type: "temporal:fact:created";
    data: {
        id: string;
        userId?: string | null;
        subject: string;
        predicate: string;
        object: string;
        validFrom: number;
        validTo: number | null;
        confidence: number;
        metadata?: Record<string, unknown>;
    };
}

export interface TemporalFactUpdatedEvent extends BaseEvent {
    type: "temporal:fact:updated";
    data: {
        id: string;
        userId?: string | null;
        confidence?: number;
        metadata?: Record<string, unknown>;
    };
}

export interface TemporalFactDeletedEvent extends BaseEvent {
    type: "temporal:fact:deleted";
    data: { id: string; userId?: string | null; validTo: number };
}

export interface TemporalEdgeCreatedEvent extends BaseEvent {
    type: "temporal:edge:created";
    data: {
        id: string;
        userId?: string | null;
        sourceId: string;
        targetId: string;
        relationType: string;
        validFrom: number;
        weight: number;
        metadata?: Record<string, unknown>;
        validTo: number | null;
    };
}

export interface TemporalEdgeUpdatedEvent extends BaseEvent {
    type: "temporal:edge:updated";
    data: {
        id: string;
        userId?: string | null;
        weight?: number;
        metadata?: Record<string, unknown>;
    };
}

export interface TemporalEdgeDeletedEvent extends BaseEvent {
    type: "temporal:edge:deleted";
    data: { id: string; userId?: string | null; validTo: number };
}

/**
 * Union of all supported event types.
 */
export type OpenMemoryEvent =
    | ConnectedEvent
    | HeartbeatEvent
    | MemoryAddedEvent
    | MemoryUpdatedEvent
    | IdeSuggestionEvent
    | IdeSessionUpdateEvent
    | TemporalFactCreatedEvent
    | TemporalFactUpdatedEvent
    | TemporalFactDeletedEvent
    | TemporalEdgeCreatedEvent
    | TemporalEdgeUpdatedEvent
    | TemporalEdgeDeletedEvent;

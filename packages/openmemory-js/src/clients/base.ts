/**
 * @file base.ts
 * @description Base class and interfaces for sub-clients.
 * @audited 2026-01-19
 */

import type { MemoryClientConfig } from "../client";

/**
 * Standard error for all OpenMemory API operations.
 */
export class OpenMemoryError extends Error {
    constructor(
        public message: string,
        public status: number,
        public code?: string,
        public details?: any
    ) {
        super(message);
        this.name = "OpenMemoryError";
    }
}

/**
 * Minimal interface for the main MemoryClient as seen by sub-clients.
 */
export interface ClientInterface {
    request<T>(path: string, options?: any): Promise<T>;
    readonly apiBaseUrl: string;
    readonly token?: string;
    readonly defaultUser?: string;
}

/**
 * Base class for namespaced sub-clients to share request logic.
 */
export abstract class BaseSubClient {
    constructor(protected client: ClientInterface) { }

    protected request<T>(path: string, options?: any): Promise<T> {
        return this.client.request<T>(path, options);
    }

    protected get defaultUser(): string | undefined {
        return this.client.defaultUser;
    }
}

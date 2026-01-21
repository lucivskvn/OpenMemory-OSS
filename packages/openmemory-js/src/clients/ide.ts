/**
 * @file ide.ts
 * @description sub-client for IDE Integration operations.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    IdeSessionResult,
    IdeEventResult,
    IdeContextResult,
    IdePatternsResult,
} from "../core/types/ai";

/**
 * IDE Integration Operations sub-client.
 */
export class IdeClient extends BaseSubClient {
    /**
     * Start a new IDE session.
     */
    async startSession(opts: {
        ide: string;
        version?: string;
        workspace?: string;
        userId?: string;
        metadata?: Record<string, unknown>;
        signal?: AbortSignal;
    }): Promise<IdeSessionResult> {
        return await this.request<IdeSessionResult>("/api/ide/session/start", {
            method: "POST",
            body: JSON.stringify({
                ide: opts.ide,
                version: opts.version,
                workspace: opts.workspace,
                userId: opts.userId || this.defaultUser,
                metadata: opts.metadata,
            }),
            signal: opts.signal,
        });
    }

    /**
     * End an active IDE session.
     */
    async endSession(
        sessionId: string,
        options?: { signal?: AbortSignal }
    ): Promise<{ success: boolean; summaryMemoryId: string }> {
        return await this.request<{ success: boolean; summaryMemoryId: string }>("/api/ide/session/end", {
            method: "POST",
            body: JSON.stringify({ sessionId }),
            signal: options?.signal,
        });
    }

    /**
     * Send an event (e.g. file open, edit, command execution) from the IDE.
     */
    async sendEvent(event: {
        sessionId: string;
        eventType: string;
        filePath?: string;
        content?: string;
        metadata?: Record<string, unknown>;
        userId?: string;
        language?: string;
        signal?: AbortSignal;
    }): Promise<IdeEventResult> {
        const { signal, ...body } = event;
        if (body.userId === undefined) (body as any).userId = this.defaultUser;
        return await this.request<IdeEventResult>("/api/ide/events", {
            method: "POST",
            body: JSON.stringify(body),
            signal: signal,
        });
    }

    /**
     * Retrieve IDE-specific context for a file or cursor position.
     */
    async getContext(
        sessionId: string,
        file: string,
        line?: number,
        options?: { signal?: AbortSignal }
    ): Promise<IdeContextResult> {
        const params = new URLSearchParams({ sessionId, file });
        if (line) params.append("line", line.toString());

        return await this.request<IdeContextResult>(`/api/ide/context?${params.toString()}`, {
            signal: options?.signal,
        });
    }

    /**
     * Get learned patterns for the current IDE session.
     */
    async getPatterns(sessionId: string, options?: { signal?: AbortSignal }): Promise<IdePatternsResult> {
        return await this.request<IdePatternsResult>(`/api/ide/patterns/${sessionId}`, {
            signal: options?.signal,
        });
    }
}

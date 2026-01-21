/**
 * @file lgm.ts
 * @description sub-client for LangGraph Memory (LGM) operations.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    LgmStoreRequest,
    LgStoreResult,
    LgmRetrieveRequest,
    LgRetrieveResult,
    LgmContextRequest,
    LgContextResult,
    LgmReflectionRequest,
    LgReflectResult,
    LgConfig,
} from "../core/types/ai";

/**
 * LangGraph Memory (LGM) Operations sub-client.
 */
export class LgmClient extends BaseSubClient {
    /**
     * Store a memory within a LangGraph/Agent context.
     */
    async store(
        req: LgmStoreRequest,
        options?: { signal?: AbortSignal }
    ): Promise<LgStoreResult> {
        const body: LgmStoreRequest = { ...req };
        if (body.userId === undefined) body.userId = this.defaultUser;

        return await this.request<LgStoreResult>("/lgm/store", {
            method: "POST",
            body: JSON.stringify(body),
            signal: options?.signal,
        });
    }

    /**
     * Retrieve memories for a specific graph node/context.
     */
    async retrieve(
        req: LgmRetrieveRequest,
        options?: { signal?: AbortSignal }
    ): Promise<LgRetrieveResult> {
        const body: LgmRetrieveRequest = { ...req };
        if (body.userId === undefined) body.userId = this.defaultUser;

        return await this.request<LgRetrieveResult>("/lgm/retrieve", {
            method: "POST",
            body: JSON.stringify(body),
            signal: options?.signal,
        });
    }

    /**
     * Get distilled context for a node (priming).
     */
    async getContext(
        req: LgmContextRequest,
        options?: { signal?: AbortSignal }
    ): Promise<LgContextResult> {
        const body: LgmContextRequest = { ...req };
        if (body.userId === undefined) body.userId = this.defaultUser;

        return await this.request<LgContextResult>("/lgm/context", {
            method: "POST",
            body: JSON.stringify(body),
            signal: options?.signal,
        });
    }

    /**
     * Trigger a reflection on graph memories.
     */
    async reflect(
        req: LgmReflectionRequest,
        options?: { signal?: AbortSignal }
    ): Promise<LgReflectResult> {
        const body: LgmReflectionRequest = { ...req };
        if (body.userId === undefined) body.userId = this.defaultUser;

        return await this.request<LgReflectResult>("/lgm/reflection", {
            method: "POST",
            body: JSON.stringify(body),
            signal: options?.signal,
        });
    }

    /**
     * Get LGM configuration.
     */
    async getConfig(options?: { signal?: AbortSignal }): Promise<LgConfig> {
        return await this.request<LgConfig>("/lgm/config", { signal: options?.signal });
    }
}

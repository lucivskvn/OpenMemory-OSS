/**
 * @file compression.ts
 * @description sub-client for Text Compression operations.
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type {
    CompressionResult,
    CompressionStats,
} from "../core/types";

/**
 * Text Compression Operations sub-client.
 */
export class CompressionClient extends BaseSubClient {
    /**
     * Compress a text string using various algorithms.
     */
    async compress(
        text: string,
        algorithm: "semantic" | "syntactic" | "aggressive" = "semantic",
        userId?: string,
        options?: { signal?: AbortSignal }
    ): Promise<CompressionResult> {
        const uid = userId || this.defaultUser;
        const res = await this.request<{ result: CompressionResult }>("/api/compression/test", {
            method: "POST",
            body: JSON.stringify({ text, algorithm, userId: uid }),
            signal: options?.signal,
        });
        return res.result;
    }

    /**
     * Get compression engine statistics.
     */
    async getStats(options?: { signal?: AbortSignal }): Promise<CompressionStats> {
        const res = await this.request<{ stats: CompressionStats }>("/api/compression/stats", { signal: options?.signal });
        return res.stats;
    }
}

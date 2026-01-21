/**
 * @file events.ts
 * @description sub-client for Real-time Event Streaming (SSE).
 * @audited 2026-01-19
 */

import { BaseSubClient } from "./base";
import type { OpenMemoryEvent } from "../core/types";

/**
 * Real-time Event Streaming sub-client.
 */
export class EventsClient extends BaseSubClient {
    /**
     * Listen to real-time events (SSE).
     * Returns a cleanup function to close the stream.
     */
    listen(
        callback: (event: OpenMemoryEvent) => void,
        options: { subscribe?: "all" | string } = {},
    ): () => void {
        const controller = new AbortController();
        const signal = controller.signal;

        // Accessing base client properties securely via interface
        const baseUrl = this.client.apiBaseUrl;
        // In this implementation, we need to handle auth tokens for SSE.
        // We'll peek at the internal token if available or assume it's handled by the fetch wrapper if we refactor more.
        // For now, mirroring original logic with better typing safely.
        const token = this.client.token;

        void (async () => {
            while (!signal.aborted) {
                try {
                    const headers: Record<string, string> = {
                        Accept: "text/event-stream",
                    };
                    if (token) {
                        headers["Authorization"] = `Bearer ${token}`;
                    }

                    const params = new URLSearchParams();
                    if (options.subscribe) params.append("subscribe", options.subscribe);

                    const response = await fetch(`${baseUrl}/stream?${params.toString()}`, {
                        headers,
                        signal,
                    });

                    if (!response.ok || !response.body) {
                        throw new Error(
                            `Failed to connect to stream: ${response.status}`,
                        );
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";

                    while (!signal.aborted) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split("\n\n");
                        buffer = lines.pop() || ""; // Keep incomplete chunk

                        for (const line of lines) {
                            if (line.startsWith("data: ")) {
                                try {
                                    const data = JSON.parse(line.slice(6));
                                    callback({
                                        type: data.type,
                                        data: data.data,
                                        timestamp: data.timestamp || Date.now(),
                                    });
                                } catch (e) {
                                    // ignore parse errors
                                }
                            }
                        }
                    }
                } catch (e: unknown) {
                    if (signal.aborted) return;
                    // Retry delay
                    await new Promise((r) => setTimeout(r, 5000));
                }
            }
        })();

        return () => controller.abort();
    }
}

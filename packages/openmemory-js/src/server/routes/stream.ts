import { eventBus, EVENTS } from "../../core/events";
import {
    IdeSessionPayload,
    IdeSuggestionPayload,
    MemoryAddedPayload,
    OpenMemoryEvent,
} from "../../core/types";
import { logger } from "../../utils/logger";
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

/**
 * Sets up the Server-Sent Events (SSE) streaming endpoint for real-time monitoring.
 * Ensures strict tenant isolation (Confidentiality) and robust cleanup (Sustainability).
 */
/**
 * SSE Client representation for multiplexing.
 */
interface SSEClient {
    id: string;
    controller: ReadableStreamDefaultController;
    encoder: TextEncoder;
    userId?: string | null;
    isAdmin: boolean;
    subscribeTarget?: string;
}

const activeClients = new Set<SSEClient>();

/**
 * Ensures events are only sent to authorized users.
 */
const shouldSend = (client: SSEClient, dataUserId?: string | null) => {
    // 1. If public/system event (no userId), send to everyone
    if (!dataUserId) return true;

    // 2. If Admin
    if (client.isAdmin) {
        if (client.subscribeTarget === "all") return true;
        if (client.subscribeTarget && client.subscribeTarget === dataUserId) return true;
        return dataUserId === client.userId;
    }

    // 3. Regular User: Strict Isolation
    return dataUserId === client.userId;
};

const broadcast = (type: string, data: any) => {
    const payload = {
        type,
        data,
        timestamp: Date.now(),
    };
    const msg = `data: ${JSON.stringify(payload)}\n\n`;

    for (const client of activeClients) {
        if (shouldSend(client, data?.userId)) {
            try {
                client.controller.enqueue(client.encoder.encode(msg));
            } catch (e) {
                // If enqueue fails, client might be dead, but we handle via abort signal mostly
                activeClients.delete(client);
            }
        }
    }
};

// Global Listeners (Single set of listeners for the whole system)
let listenersInitialized = false;
function initGlobalListeners() {
    if (listenersInitialized) return;
    listenersInitialized = true;

    eventBus.on(EVENTS.MEMORY_ADDED, (data) => broadcast(EVENTS.MEMORY_ADDED, data));
    eventBus.on(EVENTS.MEMORY_UPDATED, (data) => broadcast(EVENTS.MEMORY_UPDATED, data));
    eventBus.on(EVENTS.IDE_SUGGESTION, (data) => broadcast(EVENTS.IDE_SUGGESTION, data));
    eventBus.on(EVENTS.IDE_SESSION_UPDATE, (data) => broadcast(EVENTS.IDE_SESSION_UPDATE, data));
    eventBus.on(EVENTS.TEMPORAL_FACT_CREATED, (data) => broadcast(EVENTS.TEMPORAL_FACT_CREATED, data));
    eventBus.on(EVENTS.TEMPORAL_FACT_UPDATED, (data) => broadcast(EVENTS.TEMPORAL_FACT_UPDATED, data));
    eventBus.on(EVENTS.TEMPORAL_FACT_DELETED, (data) => broadcast(EVENTS.TEMPORAL_FACT_DELETED, data));
    eventBus.on(EVENTS.TEMPORAL_EDGE_CREATED, (data) => broadcast(EVENTS.TEMPORAL_EDGE_CREATED, data));
    eventBus.on(EVENTS.TEMPORAL_EDGE_UPDATED, (data) => broadcast(EVENTS.TEMPORAL_EDGE_UPDATED, data));
    eventBus.on(EVENTS.TEMPORAL_EDGE_DELETED, (data) => broadcast(EVENTS.TEMPORAL_EDGE_DELETED, data));

    // Heartbeat for all clients
    setInterval(() => {
        const hb = ": heartbeat\n\n";
        for (const client of activeClients) {
            try {
                client.controller.enqueue(client.encoder.encode(hb));
            } catch (_) {
                activeClients.delete(client);
            }
        }
    }, 15000);
}

/**
 * Sets up the Server-Sent Events (SSE) streaming endpoint for real-time monitoring.
 */
export function setupStream(app: ServerApp) {
    initGlobalListeners();

    app.get("/stream", (req: AdvancedRequest, res: AdvancedResponse) => {
        const client: SSEClient = {
            id: req.requestId,
            encoder: new TextEncoder(),
            userId: req.user?.id,
            isAdmin: (req.user?.scopes || []).includes("admin:all"),
            subscribeTarget: req.query.subscribe as string | undefined,
            controller: null as any // to be set in start
        };

        const stream = new ReadableStream({
            start(controller) {
                client.controller = controller;

                // Send initial connection message
                const initMsg = `data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`;
                controller.enqueue(client.encoder.encode(initMsg));

                activeClients.add(client);

                const cleanup = () => {
                    activeClients.delete(client);
                    try {
                        controller.close();
                    } catch (_) { }
                };

                if (req.signal) {
                    req.signal.addEventListener("abort", () => {
                        logger.info(`[STREAM] Client ${client.id} disconnected`);
                        cleanup();
                    }, { once: true });
                }
            },
            cancel() {
                activeClients.delete(client);
            }
        });

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no" // Important for Nginx/Cloudflare
        });

        res.send(stream);
    });
}

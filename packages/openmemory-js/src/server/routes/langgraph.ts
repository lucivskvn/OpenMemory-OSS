import { z } from "zod";

import {
    createRefl,
    getGraphCtx,
    getLgCfg,
    retrieveNodeMems,
    storeNodeMem,
} from "../../ai/graph";
import type {
    LgmContextRequest,
    LgmReflectionRequest,
    LgmRetrieveRequest,
    LgmStoreRequest,
} from "../../core/types";
import { logger } from "../../utils/logger";
import { sendError } from "../errors";
import { validateBody } from "../middleware/validate";
import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

const LgmStoreSchema = z.object({
    node: z.string().min(1),
    content: z.string().min(1),
    tags: z.array(z.string()).optional().default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
    namespace: z.string().optional(),
    graphId: z.string().optional(),
    reflective: z.boolean().optional(),
    userId: z.string().optional(),
});

const LgmRetrieveSchema = z.object({
    node: z.string().min(1),
    query: z.string().optional(),
    namespace: z.string().optional(),
    graphId: z.string().optional(),
    limit: z.number().min(1).max(100).optional().default(10),
    includeMetadata: z.boolean().optional(),
    userId: z.string().optional(),
});

const LgmContextSchema = z.object({
    node: z.string().min(1),
    namespace: z.string().optional(),
    graphId: z.string().optional(),
    userId: z.string().optional(),
});

const LgmReflectionSchema = z.object({
    node: z.string().min(1),
    content: z.string().optional(),
    contextIds: z.array(z.string()).optional(),
    namespace: z.string().optional(),
    graphId: z.string().optional(),
    userId: z.string().optional(),
    depth: z.enum(["shallow", "deep"]).optional(),
});

// Routes definition

/**
 * Registers LangGraph Memory (LGM) integration routes.
 * Enables storing and retrieving graph-aware memories.
 * @param app The server application instance.
 */
export function langGraphRoutes(app: ServerApp) {
    /**
     * GET /lgm/config
     * Returns the current LangGraph memory configuration.
     */
    app.get("/lgm/config", (_req: AdvancedRequest, res: AdvancedResponse) => {
        res.json(getLgCfg());
    });

    /**
     * POST /lgm/store
     * Stores a node-specific memory within a graph namespace.
     * Supports tagging, metadata, and optional reflection trigger.
     */
    app.post(
        "/lgm/store",
        validateBody(LgmStoreSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const body = req.body as z.infer<typeof LgmStoreSchema>;
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = req.user?.id;
                if (isAdmin && body.userId) userId = body.userId;

                const payload: LgmStoreRequest = {
                    ...body,
                    userId,
                };

                const r = await storeNodeMem(payload);
                res.json(r);
            } catch (e: unknown) {
                logger.error("[LGM] store error:", { error: e });
                sendError(res, e);
            }
        },
    );

    /**
     * POST /lgm/retrieve
     * Retrieves node memories for a specific graph/namespace.
     */
    app.post(
        "/lgm/retrieve",
        validateBody(LgmRetrieveSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const body = req.body as z.infer<typeof LgmRetrieveSchema>;
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = req.user?.id;
                if (isAdmin && body.userId) userId = body.userId;

                const payload: LgmRetrieveRequest = {
                    ...body,
                    userId,
                };

                const r = await retrieveNodeMems(payload);
                res.json(r);
            } catch (e: unknown) {
                logger.error("[LGM] retrieve error:", { error: e });
                sendError(res, e);
            }
        },
    );

    /**
     * POST /lgm/context
     * Gets distilled context for a node from previous memories.
     * Useful for priming an agent before execution.
     */
    app.post(
        "/lgm/context",
        validateBody(LgmContextSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const body = req.body as z.infer<typeof LgmContextSchema>;
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = req.user?.id;
                if (isAdmin && body.userId) userId = body.userId;

                const payload: LgmContextRequest = {
                    ...body,
                    userId,
                };

                const r = await getGraphCtx(payload);
                res.json(r);
            } catch (e: unknown) {
                logger.error("[LGM] context error:", { error: e });
                sendError(res, e);
            }
        },
    );

    /**
     * POST /lgm/reflection
     * Triggers a deeper reflective analysis of node memories.
     */
    app.post(
        "/lgm/reflection",
        validateBody(LgmReflectionSchema),
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const body = req.body as z.infer<typeof LgmReflectionSchema>;
                const isAdmin = (req.user?.scopes || []).includes("admin:all");
                let userId = req.user?.id;
                if (isAdmin && body.userId) userId = body.userId;

                const payload: LgmReflectionRequest = {
                    ...body,
                    userId,
                };

                const r = await createRefl(payload);
                res.json(r);
            } catch (e: unknown) {
                logger.error("[LGM] reflection error:", { error: e });
                sendError(res, e);
            }
        },
    );
}

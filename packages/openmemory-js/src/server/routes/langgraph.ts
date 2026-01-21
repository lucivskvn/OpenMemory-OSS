
import { Elysia } from "elysia";
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
import { getUser, getEffectiveUserId } from "../middleware/auth";
import type { UserContext } from "../middleware/auth";
import { logger } from "../../utils/logger";

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

/**
 * Registers LangGraph Memory (LGM) integration routes.
 * Enables storing and retrieving graph-aware memories.
 */
export const langGraphRoutes = (app: Elysia) => app.group("/lgm", (app) => {
    return app
        /**
         * GET /lgm/config
         * Returns the current LangGraph memory configuration.
         */
        .get("/config", () => {
            return getLgCfg();
        })

        /**
         * POST /lgm/store
         * Stores a node-specific memory within a graph namespace.
         */
        .post("/store", async ({ body, ...ctx }) => {
            const data = LgmStoreSchema.parse(body);
            const user = getUser(ctx);
            const userId = getEffectiveUserId(user, data.userId);

            const payload: LgmStoreRequest = {
                ...data,
                userId,
            };

            return await storeNodeMem(payload);
        })

        /**
         * POST /lgm/retrieve
         * Retrieves node memories for a specific graph/namespace.
         */
        .post("/retrieve", async ({ body, ...ctx }) => {
            const data = LgmRetrieveSchema.parse(body);
            const user = getUser(ctx);
            const userId = getEffectiveUserId(user, data.userId);

            const payload: LgmRetrieveRequest = {
                ...data,
                userId,
            };

            return await retrieveNodeMems(payload);
        })

        /**
         * POST /lgm/context
         * Gets distilled context for a node from previous memories.
         */
        .post("/context", async ({ body, ...ctx }) => {
            const data = LgmContextSchema.parse(body);
            const user = getUser(ctx);
            const userId = getEffectiveUserId(user, data.userId);

            const payload: LgmContextRequest = {
                ...data,
                userId,
            };

            return await getGraphCtx(payload);
        })

        /**
         * POST /lgm/reflection
         * Triggers a deeper reflective analysis of node memories.
         */
        .post("/reflection", async ({ body, ...ctx }) => {
            const data = LgmReflectionSchema.parse(body);
            const user = getUser(ctx);
            const userId = getEffectiveUserId(user, data.userId);

            const payload: LgmReflectionRequest = {
                ...data,
                userId,
            };

            return await createRefl(payload);
        });
});

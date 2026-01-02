import {
    store_node_mem,
    retrieve_node_mems,
    get_graph_ctx,
    create_refl,
    get_lg_cfg,
} from "../../ai/graph";
import type {
    lgm_store_req,
    lgm_retrieve_req,
    lgm_context_req,
    lgm_reflection_req,
} from "../../core/types";
import { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import { z } from "zod";

const LgmStoreSchema = z.object({
    node: z.string().min(1),
    content: z.string().min(1),
    tags: z.array(z.string()).optional().default([]),
    metadata: z.record(z.unknown()).optional(),
    namespace: z.string().optional(),
    graph_id: z.string().optional(),
    reflective: z.boolean().optional(),
    user_id: z.string().optional()
});

const LgmRetrieveSchema = z.object({
    node: z.string().min(1),
    query: z.string().optional(),
    namespace: z.string().optional(),
    graph_id: z.string().optional(),
    limit: z.number().min(1).max(100).optional().default(10),
    include_metadata: z.boolean().optional(),
    user_id: z.string().optional()
});

const LgmContextSchema = z.object({
    node: z.string().min(1),
    namespace: z.string().optional(),
    graph_id: z.string().optional(),
    user_id: z.string().optional()
});

const LgmReflectionSchema = z.object({
    node: z.string().min(1),
    namespace: z.string().optional(),
    graph_id: z.string().optional(),
    user_id: z.string().optional(),
    depth: z.enum(["shallow", "deep"]).optional()
});

export function lg(app: any) {
    app.get("/lgm/config", (_req: AdvancedRequest, res: AdvancedResponse) => {
        res.json(get_lg_cfg());
    });

    app.post("/lgm/store", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = LgmStoreSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid store parameters", validated.error.format()));
            }
            // Ensure user_id from auth if not provided (or overwrite?) 
            // Usually auth user_id trumps body, but let's stick to consistent pattern:
            const payload = { ...validated.data, user_id: req.user?.id || validated.data.user_id };

            const r = await store_node_mem(payload);
            res.json(r);
        } catch (e: unknown) {
            console.error("[LGM] store error:", e);
            sendError(res, e);
        }
    });

    app.post("/lgm/retrieve", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = LgmRetrieveSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid retrieve parameters", validated.error.format()));
            }
            const payload = { ...validated.data, user_id: req.user?.id || validated.data.user_id };

            const r = await retrieve_node_mems(payload);
            res.json(r);
        } catch (e: unknown) {
            console.error("[LGM] retrieve error:", e);
            sendError(res, e);
        }
    });

    app.post("/lgm/context", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = LgmContextSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid context parameters", validated.error.format()));
            }
            const payload = { ...validated.data, user_id: req.user?.id || validated.data.user_id };

            const r = await get_graph_ctx(payload);
            res.json(r);
        } catch (e: unknown) {
            console.error("[LGM] context error:", e);
            sendError(res, e);
        }
    });

    app.post("/lgm/reflection", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = LgmReflectionSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid reflection parameters", validated.error.format()));
            }
            const payload = { ...validated.data, user_id: req.user?.id || validated.data.user_id };

            const r = await create_refl(payload as any); // Cast as needed if type mismatch exists
            res.json(r);
        } catch (e: unknown) {
            console.error("[LGM] reflection error:", e);
            sendError(res, e);
        }
    });
}

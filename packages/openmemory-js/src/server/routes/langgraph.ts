import { z } from "zod";
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

const LgmStoreReqSchema = z
    .object({
        memory: z.record(z.any()).optional(),
        content: z.string().optional(),
        metadata: z.record(z.any()).optional(),
        session_id: z.string().optional(),
        tags: z.array(z.string()).optional(),
    })
    .passthrough();

const LgmRetrieveReqSchema = z
    .object({
        query: z.string().optional(),
        session_id: z.string().optional(),
        limit: z.number().optional(),
    })
    .passthrough();

const LgmContextReqSchema = z
    .object({
        session_id: z.string().optional(),
    })
    .passthrough();

const LgmReflectionReqSchema = z
    .object({
        session_id: z.string().optional(),
    })
    .passthrough();

export function lg(app: any) {
    app.get("/lgm/config", (_req: any, res: any) => {
        res.json(get_lg_cfg());
    });

    app.post("/lgm/store", async (req: any, res: any) => {
        try {
            const parsedBody = LgmStoreReqSchema.parse(req.body);
            const r = await store_node_mem(parsedBody as lgm_store_req);
            res.json(r);
        } catch (e) {
            console.error("[LGM] store error:", e);
            res.status(400).json({
                err: "lgm_store_failed",
                message: (e as Error).message,
            });
        }
    });

    app.post("/lgm/retrieve", async (req: any, res: any) => {
        try {
            const parsedBody = LgmRetrieveReqSchema.parse(req.body);
            const r = await retrieve_node_mems(parsedBody as lgm_retrieve_req);
            res.json(r);
        } catch (e) {
            console.error("[LGM] retrieve error:", e);
            res.status(400).json({
                err: "lgm_retrieve_failed",
                message: (e as Error).message,
            });
        }
    });

    app.post("/lgm/context", async (req: any, res: any) => {
        try {
            const parsedBody = LgmContextReqSchema.parse(req.body);
            const r = await get_graph_ctx(parsedBody as lgm_context_req);
            res.json(r);
        } catch (e) {
            console.error("[LGM] context error:", e);
            res.status(400).json({
                err: "lgm_context_failed",
                message: (e as Error).message,
            });
        }
    });

    app.post("/lgm/reflection", async (req: any, res: any) => {
        try {
            const parsedBody = LgmReflectionReqSchema.parse(req.body);
            const r = await create_refl(parsedBody as lgm_reflection_req);
            res.json(r);
        } catch (e) {
            console.error("[LGM] reflection error:", e);
            res.status(400).json({
                err: "lgm_reflection_failed",
                message: (e as Error).message,
            });
        }
    });
}

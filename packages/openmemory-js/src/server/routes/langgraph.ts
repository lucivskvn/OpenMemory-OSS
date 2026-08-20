import { z } from "zod";
import {
    store_node_mem,
    retrieve_node_mems,
    get_graph_ctx,
    create_refl,
    get_lg_cfg,
} from "../../ai/graph";
import { require_tenant, reject_tenant_mismatch } from "../middleware/tenant";
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
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        try {
            const parsedBody = LgmStoreReqSchema.parse(req.body);
            if (reject_tenant_mismatch(res, tenant, parsedBody.user_id)) return;
            const r = await store_node_mem({
                ...parsedBody,
                user_id: tenant,
            } as lgm_store_req);
            res.json(r);
        } catch (e) {
            console.error("[LGM] store error:", e);
            res.status(400).json({
                err: "lgm_store_failed",
                message: "internal",
            });
        }
    });

    app.post("/lgm/retrieve", async (req: any, res: any) => {
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        try {
            const parsedBody = LgmRetrieveReqSchema.parse(req.body);
            if (reject_tenant_mismatch(res, tenant, parsedBody.user_id)) return;
            const r = await retrieve_node_mems({
                ...parsedBody,
                user_id: tenant,
            } as lgm_retrieve_req);
            res.json(r);
        } catch (e) {
            console.error("[LGM] retrieve error:", e);
            res.status(400).json({
                err: "lgm_retrieve_failed",
                message: "internal",
            });
        }
    });

    app.post("/lgm/context", async (req: any, res: any) => {
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        try {
            const parsedBody = LgmContextReqSchema.parse(req.body);
            if (reject_tenant_mismatch(res, tenant, parsedBody.user_id)) return;
            const r = await get_graph_ctx({
                ...parsedBody,
                user_id: tenant,
            } as lgm_context_req);
            res.json(r);
        } catch (e) {
            console.error("[LGM] context error:", e);
            res.status(400).json({
                err: "lgm_context_failed",
                message: "internal",
            });
        }
    });

    app.post("/lgm/reflection", async (req: any, res: any) => {
        const tenant = require_tenant(req, res);
        if (!tenant) return;
        try {
            const parsedBody = LgmReflectionReqSchema.parse(req.body);
            if (reject_tenant_mismatch(res, tenant, parsedBody.user_id)) return;
            const r = await create_refl({
                ...parsedBody,
                user_id: tenant,
            } as lgm_reflection_req);
            res.json(r);
        } catch (e) {
            console.error("[LGM] reflection error:", e);
            res.status(400).json({
                err: "lgm_reflection_failed",
                message: "internal",
            });
        }
    });
}

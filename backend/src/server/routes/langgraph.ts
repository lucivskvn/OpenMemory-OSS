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

export function lg(app: any) {
    app.get("/lgm/config", (_req: any) => {
        return new Response(JSON.stringify(get_lg_cfg()), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    app.post("/lgm/store", async (req: any) => {
        try {
            const r = await store_node_mem(req.body as lgm_store_req);
            return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (e) {
            console.error("[LGM] store error:", e);
            return new Response(JSON.stringify({
                err: "lgm_store_failed",
                message: (e as Error).message,
            }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
    });

    app.post("/lgm/retrieve", async (req: any) => {
        try {
            const r = await retrieve_node_mems(req.body as lgm_retrieve_req);
            return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (e) {
            console.error("[LGM] retrieve error:", e);
            return new Response(JSON.stringify({
                err: "lgm_retrieve_failed",
                message: (e as Error).message,
            }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
    });

    app.post("/lgm/context", async (req: any) => {
        try {
            const r = await get_graph_ctx(req.body as lgm_context_req);
            return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (e) {
            console.error("[LGM] context error:", e);
            return new Response(JSON.stringify({
                err: "lgm_context_failed",
                message: (e as Error).message,
            }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
    });

    app.post("/lgm/reflection", async (req: any) => {
        try {
            const r = await create_refl(req.body as lgm_reflection_req);
            return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (e) {
            console.error("[LGM] reflection error:", e);
            return new Response(JSON.stringify({
                err: "lgm_reflection_failed",
                message: (e as Error).message,
            }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
    });
}

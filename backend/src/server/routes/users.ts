import { q } from "../../core/db";
import { p } from "../../utils";
import {
    update_user_summary,
    auto_update_user_summaries,
} from "../../memory/user_summary";

export const usr = (app: any) => {
    app.get("/users/:user_id/summary", async (req: any) => {
        try {
            const { user_id } = req.params;
            if (!user_id)
                return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });

            const user = await q.get_user.get(user_id);
            if (!user) return new Response(JSON.stringify({ error: "user not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

            return new Response(JSON.stringify({
                user_id: user.user_id,
                summary: user.summary,
                reflection_count: user.reflection_count,
                updated_at: user.updated_at,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (err: any) {
            return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.post("/users/:user_id/summary/regenerate", async (req: any) => {
        try {
            const { user_id } = req.params;
            if (!user_id) return new Response(JSON.stringify({ err: "user_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });

            await update_user_summary(user_id);
            const user = await q.get_user.get(user_id);

            return new Response(JSON.stringify({
                ok: true,
                user_id,
                summary: user?.summary,
                reflection_count: user?.reflection_count,
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (err: any) {
            return new Response(JSON.stringify({ err: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.post("/users/summaries/regenerate-all", async () => {
        try {
            const result = await auto_update_user_summaries();
            return new Response(JSON.stringify({ ok: true, updated: result.updated }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (err: any) {
            return new Response(JSON.stringify({ err: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.get("/users/:user_id/memories", async (req: any) => {
        try {
            const { user_id } = req.params;
            if (!user_id) return new Response(JSON.stringify({ err: "user_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });

            const l = req.query.l ? parseInt(req.query.l) : 100;
            const u = req.query.u ? parseInt(req.query.u) : 0;

            const r = await q.all_mem_by_user.all(user_id, l, u);
            const i = r.map((x: any) => ({
                id: x.id,
                content: x.content,
                tags: p(x.tags),
                metadata: p(x.meta),
                created_at: x.created_at,
                updated_at: x.updated_at,
                last_seen_at: x.last_seen_at,
                salience: x.salience,
                decay_lambda: x.decay_lambda,
                primary_sector: x.primary_sector,
                version: x.version,
            }));
            return new Response(JSON.stringify({ user_id, items: i }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (err: any) {
            return new Response(JSON.stringify({ err: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });

    app.delete("/users/:user_id/memories", async (req: any) => {
        try {
            const { user_id } = req.params;
            if (!user_id) return new Response(JSON.stringify({ err: "user_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });

            const mems = await q.all_mem_by_user.all(user_id, 10000, 0);
            let deleted = 0;

            for (const m of mems) {
                await q.del_mem.run(m.id);
                await q.del_vec.run(m.id);
                await q.del_waypoints.run(m.id, m.id);
                deleted++;
            }

            return new Response(JSON.stringify({ ok: true, deleted }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch (err: any) {
            return new Response(JSON.stringify({ err: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    });
};

import { q, vector_store } from "../../core/db";
import { MemoryRow } from "../../core/types";
import { p } from "../../utils";
import {
    update_user_summary,
    auto_update_user_summaries,
} from "../../memory/user_summary";
import { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import { z } from "zod";

export const usr = (app: any) => {
    app.get("/users", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const users = await q.get_active_users.all();
            res.json({ users: users.map(u => u.user_id) });
        } catch (err: unknown) {
            sendError(res, err);
        }
    });

    app.get("/users/:user_id", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { user_id } = req.params;
            const auth_user_id = req.user?.id;

            // Security: Users can only see their own profile unless unauthenticated (open mode)
            if (auth_user_id && auth_user_id !== user_id) {
                return sendError(res, new AppError(403, "FORBIDDEN", "Forbidden"));
            }

            const user = await q.get_user.get(user_id);
            if (!user) return sendError(res, new AppError(404, "NOT_FOUND", "user not found"));
            res.json(user);
        } catch (err: unknown) {
            sendError(res, err);
        }
    });

    app.get("/users/:user_id/summary", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { user_id } = req.params;
            const auth_user_id = req.user?.id;

            if (!user_id) return sendError(res, new AppError(400, "MISSING_USER_ID", "user_id required"));

            if (auth_user_id && auth_user_id !== user_id) {
                return sendError(res, new AppError(403, "FORBIDDEN", "forbidden"));
            }

            const user = await q.get_user.get(user_id);
            if (!user) return sendError(res, new AppError(404, "NOT_FOUND", "user not found"));

            res.json({
                user_id: user.user_id,
                summary: user.summary,
                reflection_count: user.reflection_count,
                updated_at: user.updated_at,
            });
        } catch (err: unknown) {
            sendError(res, err);
        }
    });

    app.post(
        "/users/:user_id/summary/regenerate",
        async (req: AdvancedRequest, res: AdvancedResponse) => {
            try {
                const { user_id } = req.params;
                const auth_user_id = req.user?.id;

                if (!user_id) return sendError(res, new AppError(400, "MISSING_USER_ID", "user_id required"));

                if (auth_user_id && auth_user_id !== user_id) {
                    return sendError(res, new AppError(403, "FORBIDDEN", "forbidden"));
                }

                await update_user_summary(user_id);
                const user = await q.get_user.get(user_id);

                res.json({
                    ok: true,
                    user_id,
                    summary: user?.summary,
                    reflection_count: user?.reflection_count,
                });
            } catch (err: unknown) {
                sendError(res, err);
            }
        },
    );

    app.post("/users/summaries/regenerate-all", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const result = await auto_update_user_summaries();
            res.json({ ok: true, updated: result.updated });
        } catch (err: unknown) {
            sendError(res, err);
        }
    });

    app.get("/users/:user_id/memories", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { user_id } = req.params;
            const auth_user_id = req.user?.id;
            if (!user_id)
                return sendError(res, new AppError(400, "MISSING_USER_ID", "user_id required"));

            if (auth_user_id && auth_user_id !== user_id) {
                return sendError(res, new AppError(403, "FORBIDDEN", "forbidden"));
            }

            const validated = z.object({
                l: z.string().or(z.number()).optional().default(100),
                u: z.string().or(z.number()).optional().default(0)
            }).safeParse(req.query)

            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid pagination parameters", validated.error.format()));
            }

            const l = typeof validated.data.l === 'string' ? parseInt(validated.data.l) : validated.data.l;
            const u = typeof validated.data.u === 'string' ? parseInt(validated.data.u) : validated.data.u;

            const r = await q.all_mem_by_user.all(user_id, l, u);
            const i = r.map((x: MemoryRow) => ({
                id: x.id,
                content: x.content,
                tags: p(x.tags || "[]"),
                metadata: p(x.meta || "{}"),
                created_at: x.created_at,
                updated_at: x.updated_at,
                last_seen_at: x.last_seen_at,
                salience: x.salience,
                decay_lambda: x.decay_lambda,
                primary_sector: x.primary_sector,
                version: x.version,
            }));
            res.json({ user_id, items: i });
        } catch (err: any) {
            sendError(res, err);
        }
    });

    app.delete("/users/:user_id/memories", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const { user_id } = req.params;
            const auth_user_id = req.user?.id;

            if (!user_id) return sendError(res, new AppError(400, "MISSING_USER_ID", "user_id required"));

            if (auth_user_id && auth_user_id !== user_id) {
                return sendError(res, new AppError(403, "FORBIDDEN", "forbidden"));
            }

            const mems = await q.all_mem_by_user.all(user_id, 10000, 0);
            let deleted = 0;

            for (const m of mems) {
                await q.del_mem.run(m.id, user_id);
                await vector_store.deleteVectors(m.id);
                deleted++;
            }

            res.json({ ok: true, deleted });
        } catch (err: unknown) {
            sendError(res, err);
        }
    });
};

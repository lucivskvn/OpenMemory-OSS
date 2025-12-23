import { q } from "../../core/db";
import { p } from "../../utils";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";

export const usr = (app: Elysia) =>
    app.group("/api/users", (app) =>
        app
            .get("/", async ({ set }) => {
                try {
                    // Need a new query in db.ts to get all users with details?
                    // q.get_all_user_ids gets only IDs.
                    // Ideally we want summary/counts.
                    // For now, let's just return IDs and fetch details if needed, or implement a new query.
                    // CLI expects list of users with counts.
                    // Let's implement q.get_all_users_full or similar.
                    // But for now, let's use q.get_all_user_ids and fetch details (N+1 but simple for admin CLI).
                    // Or better, update db.ts to get full user list.
                    // q.get_all_user_ids is: select distinct user_id from memories.
                    // But we have a users table now!
                    // q.get_user gets from users table.
                    // So we should just select * from users.
                    // Let's check db.ts for 'get_all_users'.
                    // It doesn't exist.
                    // I will add it here inline or assume I can add it to db.ts.
                    // Adding to db.ts is cleaner.
                    // But I cannot edit db.ts in this turn easily without context switch?
                    // I can just query directly if I import run_async/all_async.
                    // They are exported from db.ts.

                    const users = await import("../../core/db").then(m => m.all_async("select * from users order by updated_at desc limit 100"));
                    // We also need memory counts.
                    // "select count(*) from memories where user_id=?"
                    // This is heavy.
                    // For CLI, maybe just return users table data.
                    return { users };
                } catch (e: any) {
                    log.error("List users failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            })
            .get("/:id", async ({ params: { id }, set }) => {
                try {
                    const u = await q.get_user.get(id);
                    if (!u) {
                        set.status = 404;
                        return { err: "nf" };
                    }
                    return {
                        user_id: u.user_id,
                        summary: u.summary,
                        reflection_count: u.reflection_count,
                        created_at: u.created_at,
                        updated_at: u.updated_at,
                    };
                } catch (e: any) {
                    log.error("Get user failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                params: t.Object({ id: t.String() })
            })
            .get("/:id/memories", async ({ params: { id }, query, set }) => {
                try {
                    const l = query.limit ? Number(query.limit) : 20;
                    const o = query.offset ? Number(query.offset) : 0;
                    const m = await q.all_mem_by_user.all(id, l, o);
                    const i = m.map((x: any) => ({
                        id: x.id,
                        content: x.content,
                        tags: p(x.tags),
                        metadata: p(x.meta),
                        created_at: x.created_at,
                        updated_at: x.updated_at,
                        last_seen_at: x.last_seen_at,
                        salience: x.salience,
                        primary_sector: x.primary_sector,
                    }));
                    return { items: i };
                } catch (e: any) {
                    log.error("Get user memories failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                params: t.Object({ id: t.String() }),
                query: t.Object({
                    limit: t.Optional(t.Union([t.String(), t.Numeric()])),
                    offset: t.Optional(t.Union([t.String(), t.Numeric()]))
                })
            })
            // Alias for SDK compatibility
            .get("/:id/summary", async ({ params: { id }, set }) => {
                try {
                    const u = await q.get_user.get(id);
                    if (!u) {
                        set.status = 404;
                        return { err: "nf" };
                    }
                    return {
                        user_id: u.user_id,
                        summary: u.summary,
                        reflection_count: u.reflection_count,
                        updated_at: u.updated_at,
                    };
                } catch (e: any) {
                    log.error("Get user summary failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                params: t.Object({ id: t.String() })
            })
            .delete("/:id/memories", async ({ params: { id }, set }) => {
                try {
                    // Delete all memories for this user
                    // We iterate to cleanup vectors/waypoints properly or use batch delete if available.
                    // q.del_mem deletes by ID.
                    // We need to fetch all IDs first.
                    // This could be heavy for massive users, but safe for now.
                    const mems = await q.all_mem_by_user.all(id, 10000, 0); // Cap at 10k for safety
                    let deleted = 0;
                    // Import vector_store locally to avoid circular dependency if any (though route imports usually fine)
                    const { vector_store } = await import("../../core/db");

                    for (const m of mems) {
                        await q.del_mem.run(m.id);
                        await vector_store.deleteVectors(m.id);
                        await q.del_waypoints.run(m.id, m.id);
                        deleted++;
                    }
                    log.info("Deleted user memories", { user_id: id, count: deleted });
                    return { deleted };
                } catch (e: any) {
                    log.error("Delete user memories failed", { error: e.message });
                    set.status = 500;
                    return { err: "internal" };
                }
            }, {
                params: t.Object({ id: t.String() })
            })
    );

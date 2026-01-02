import { q } from "../../core/db";
import { MemoryRow } from "../../core/types";
import { get_encryption } from "../../core/security";
import { add_hsg_memory, hsg_query } from "../../memory/hsg";
import { update_user_summary } from "../../memory/user_summary";
import { j, p } from "../../utils";
import { AdvancedRequest, AdvancedResponse } from "../index";
import { AppError, sendError } from "../errors";
import { z } from "zod";

const IdeEventSchema = z.object({
    event_type: z.string().min(1),
    file_path: z.string().optional().default("unknown"),
    content: z.string().optional().default(""),
    session_id: z.string().optional().default("default"),
    metadata: z.record(z.any()).optional().default({})
});

const IdeContextSchema = z.object({
    query: z.string().min(1),
    k: z.number().optional().or(z.string().transform(v => parseInt(v))).default(5),
    session_id: z.string().optional(),
    file_path: z.string().optional()
});

const IdeSessionStartSchema = z.object({
    project_name: z.string().optional().default("unknown"),
    ide_name: z.string().optional().default("unknown")
});

export function ide(app: any) {
    app.post("/api/ide/events", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = IdeEventSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid event data", validated.error.format()));
            }

            const { event_type, file_path, content, session_id, metadata } = validated.data;
            const user_id = req.user?.id;

            let memory_content = "";
            if (event_type === "open") {
                memory_content = `Opened file: ${file_path}`;
            } else if (event_type === "save") {
                memory_content = content ? `Saved file: ${file_path}\n\n${content}` : `Saved file: ${file_path}`;
            } else if (event_type === "close") {
                memory_content = `Closed file: ${file_path}`;
            } else {
                memory_content = `[${event_type}] ${file_path}\n${content}`.trim();
            }

            const full_metadata = {
                ...metadata,
                ide_event_type: event_type,
                ide_file_path: file_path,
                ide_session_id: session_id,
                ide_timestamp: Date.now(),
                ide_mode: true,
            };

            const result = await add_hsg_memory(
                memory_content,
                undefined,
                full_metadata,
                user_id,
            );

            if (user_id) {
                update_user_summary(user_id).catch(err =>
                    console.error("[IDE] Failed to update user summary:", err)
                );
            }

            res.json({
                success: true,
                memory_id: result.id,
                primary_sector: result.primary_sector,
                sectors: result.sectors,
            });
        } catch (err: unknown) {
            console.error("[IDE] Error storing IDE event:", err);
            sendError(res, err);
        }
    });

    app.post("/api/ide/context", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = IdeContextSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid context query", validated.error.format()));
            }

            const { query, k, session_id, file_path } = validated.data;
            const user_id = req.user?.id;

            const results = await hsg_query(query, k, {
                user_id,
                sectors: file_path ? ["semantic", "episodic"] : undefined,
            });

            let filtered = results;

            if (session_id) {
                filtered = [];
                for (const r of results) {
                    const mem = await q.get_mem.get(r.id, user_id);
                    if (mem) {
                        const meta = p(mem.meta || "{}");
                        if (meta && meta.ide_session_id === session_id) {
                            filtered.push(r);
                        }
                    }
                }
            }

            if (file_path) {
                filtered = filtered.filter((r) =>
                    r.content.toLowerCase().includes(file_path.toLowerCase()) ||
                    (r.path && r.path.toLowerCase().includes(file_path.toLowerCase()))
                );
            }

            const formatted = filtered.map((r) => ({
                memory_id: r.id,
                content: r.content,
                primary_sector: r.primary_sector,
                sectors: r.sectors,
                score: r.score,
                salience: r.salience,
                last_seen_at: r.last_seen_at,
                path: r.path,
            }));

            res.json({
                success: true,
                memories: formatted,
                total: formatted.length,
                query: query,
            });
        } catch (err: unknown) {
            console.error("[IDE] Error retrieving IDE context:", err);
            sendError(res, err);
        }
    });

    app.post("/api/ide/session/start", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = IdeSessionStartSchema.safeParse(req.body);
            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "Invalid session start data", validated.error.format()));
            }

            const { project_name, ide_name } = validated.data;
            const user_id = req.user?.id;

            const random_bytes = new Uint8Array(7);
            globalThis.crypto.getRandomValues(random_bytes);
            const hex = Buffer.from(random_bytes).toString("hex");
            const session_id = `session_${Date.now()}_${hex}`;
            const now_ts = Date.now();

            const content = `Session started: ${user_id || "public"} in ${project_name} using ${ide_name}`;

            const metadata = {
                ide_session_id: session_id,
                ide_user_id: user_id,
                ide_project_name: project_name,
                ide_name: ide_name,
                session_start_time: now_ts,
                session_type: "ide_session",
                ide_mode: true,
            };

            const result = await add_hsg_memory(content, undefined, metadata, user_id);

            if (user_id) {
                update_user_summary(user_id).catch(err =>
                    console.error("[IDE] Failed to update summary on session start:", err)
                );
            }

            res.json({
                success: true,
                session_id: session_id,
                memory_id: result.id,
                started_at: now_ts,
                user_id: user_id,
                project_name: project_name,
                ide_name: ide_name,
            });
        } catch (err: unknown) {
            console.error("[IDE] Error starting IDE session:", err);
            sendError(res, err);
        }
    });

    app.post("/api/ide/session/end", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const validated = z.object({
                session_id: z.string().min(1)
            }).safeParse(req.body);

            if (!validated.success) {
                return sendError(res, new AppError(400, "VALIDATION_ERROR", "session_id is required", validated.error.format()));
            }

            const { session_id } = validated.data;
            const user_id = req.user?.id;
            const now_ts = Date.now();

            const session_memories = await q.get_mem_by_meta_like.all(`"ide_session_id":"${session_id}"`, user_id);

            const total_events = session_memories.length;
            const sectors: Record<string, number> = {};
            const files = new Set<string>();

            for (const m of session_memories) {
                sectors[m.primary_sector] = (sectors[m.primary_sector] || 0) + 1;
                try {
                    const meta = p(m.meta || "{}");
                    if (meta && meta.ide_file_path && meta.ide_file_path !== "unknown") {
                        files.add(meta.ide_file_path);
                    }
                } catch { }
            }

            const summary = `Session ${session_id} ended. Events: ${total_events}, Files: ${files.size}, Sectors: ${j(sectors)}`;

            const metadata = {
                ide_session_id: session_id,
                session_end_time: now_ts,
                session_type: "ide_session_end",
                total_events: total_events,
                sectors_distribution: sectors,
                files_touched: Array.from(files),
                ide_mode: true,
            };

            const result = await add_hsg_memory(summary, undefined, metadata, user_id);

            if (user_id) {
                update_user_summary(user_id).catch(err =>
                    console.error("[IDE] Failed to update summary on session end:", err)
                );
            }

            res.json({
                success: true,
                session_id: session_id,
                ended_at: now_ts,
                summary_memory_id: result.id,
                statistics: {
                    total_events: total_events,
                    sectors: sectors,
                    unique_files: files.size,
                    files: Array.from(files),
                },
            });
        } catch (err: unknown) {
            console.error("[IDE] Error ending IDE session:", err);
            sendError(res, err);
        }
    });

    app.get("/api/ide/patterns/:session_id", async (req: AdvancedRequest, res: AdvancedResponse) => {
        try {
            const session_id = req.params.session_id;
            if (!session_id) return sendError(res, new AppError(400, "MISSING_SESSION_ID", "session_id is required"));

            const user_id = req.user?.id;
            const all_session_memories = await q.get_mem_by_meta_like.all(`"ide_session_id":"${session_id}"`, user_id);
            const procedural = all_session_memories.filter((m: MemoryRow) => m.primary_sector === "procedural");

            const enc = get_encryption();
            const patterns = await Promise.all(procedural.map(async (m: MemoryRow) => {
                const decrypted_content = await enc.decrypt(m.content);
                return {
                    pattern_id: m.id,
                    description: decrypted_content,
                    salience: m.salience,
                    detected_at: m.created_at,
                    last_reinforced: m.last_seen_at,
                };
            }));

            res.json({
                success: true,
                session_id: session_id,
                pattern_count: patterns.length,
                patterns: patterns,
            });
        } catch (err: unknown) {
            console.error("[IDE] Error detecting patterns:", err);
            sendError(res, err);
        }
    });
}

import { q, Memory } from "../core/db";
import { env } from "../core/cfg";

const gen_user_summary = (mems: Memory[]): string => {
    if (!mems.length) return "User profile initializing... (No memories recorded yet)";

    const projects = new Set<string>();
    const languages = new Set<string>();
    const files = new Set<string>();

    let saves = 0;

    for (const m of mems) {
        if (m.meta) {
            try {
                const meta = typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta;
                if (meta.ide_project_name) projects.add(meta.ide_project_name);
                if (meta.language) languages.add(meta.language);
                if (meta.ide_file_path) {
                    const fname = meta.ide_file_path.split(/[\\/]/).pop();
                    if (fname) files.add(fname);
                }
                if (meta.ide_event_type === 'save') saves++;
            } catch (e) { /* ignore */ }
        }
    }

    const project_str = projects.size > 0 ? Array.from(projects).join(", ") : "Unknown Project";
    const lang_str = languages.size > 0 ? Array.from(languages).join(", ") : "General";
    const recent_files = Array.from(files).slice(0, 5).join(", ");
    const last_active = mems[0].created_at ? new Date(mems[0].created_at).toLocaleString() : "Recently";

    return `Active in ${project_str} using ${lang_str}. Recently working on: ${recent_files || "various files"}. Summarized from ${mems.length} events (${saves} saves). Last active: ${last_active}.`;
};

export const gen_user_summary_async = async (
    user_id: string,
): Promise<string> => {
    const mems = await q.all_mem_by_user.all(user_id, 100, 0);
    return gen_user_summary(mems);
};

export const update_user_summary = async (user_id: string): Promise<void> => {
    try {
        const summary = await gen_user_summary_async(user_id);
        const now = Date.now();

        const existing = await q.get_user.get(user_id);
        if (!existing) {
            await q.ins_user.run(user_id, summary, 0, now, now);
        } else {
            await q.upd_user_summary.run(user_id, summary, now);
        }
    } catch (e) {
        console.error(`[USER_SUMMARY] Fatal error for ${user_id}:`, e);
    }
};

export const auto_update_user_summaries = async (): Promise<{
    updated: number;
}> => {
    const users = await q.get_active_users.all();
    const user_ids = users.map((u: any) => u.user_id).filter(Boolean);

    let updated = 0;
    for (const uid of user_ids) {
        try {
            await update_user_summary(uid as string);
            updated++;
        } catch (e) {
            console.error(`[USER_SUMMARY] Failed for ${uid}:`, e);
        }
    }

    return { updated };
};

let timer: NodeJS.Timeout | null = null;

export const start_user_summary_reflection = () => {
    if (timer) return;
    const int = (env.user_summary_interval || 30) * 60000;
    timer = setInterval(
        () =>
            auto_update_user_summaries().catch((e) => {
                if (env.verbose) console.error("[USER_SUMMARY]", e);
            }),
        int,
    );
};

export const stop_user_summary_reflection = () => {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
};

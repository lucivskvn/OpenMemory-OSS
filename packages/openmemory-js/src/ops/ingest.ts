import { add_hsg_memory } from "../memory/hsg";
import { q, transaction } from "../core/db";
import { rid, now, j } from "../utils";
import { extractText, ExtractionResult } from "./extract";
import { env } from "../core/cfg";

const LG = 8000,
    SEC = 3000;

export interface ingestion_cfg {
    force_root?: boolean;
    sec_sz?: number;
    lg_thresh?: number;
}
export interface IngestionResult {
    root_memory_id: string;
    child_count: number;
    total_tokens: number;
    strategy: "single" | "root-child";
    extraction: ExtractionResult["metadata"];
}

const split = (t: string, sz: number): string[] => {
    if (t.length <= sz) return [t];
    const secs: string[] = [];
    const paras = t.split(/\n\n+/);
    let cur = "";
    for (const p of paras) {
        if (cur.length + p.length > sz && cur.length > 0) {
            secs.push(cur.trim());
            cur = p;
        } else cur += (cur ? "\n\n" : "") + p;
    }
    if (cur.trim()) secs.push(cur.trim());
    return secs;
};

const createRootMemory = async (
    text: string,
    extraction: ExtractionResult,
    metadata?: Record<string, unknown>,
    user_id?: string | null,
) => {
    const summary_snippet = text.length > 500 ? text.slice(0, 500) + "..." : text;
    const content = `[Document: ${extraction.metadata.content_type.toUpperCase()}]\n\n${summary_snippet}\n\n[Full content split across ${Math.ceil(text.length / SEC)} sections]`;
    const memory_id = rid(),
        timestamp = now();
    await transaction.begin();
    try {
        await q.ins_mem.run(
            memory_id,
            content,
            "reflective",
            j([]),
            j({
                ...metadata,
                ...extraction.metadata,
                is_root: true,
                ingestion_strategy: "root-child",
                ingested_at: timestamp,
            }),
            timestamp,
            timestamp,
            timestamp,
            1.0,
            0.1,
            1,
            user_id || "anonymous",
            null,
        );
        await transaction.commit();
        return memory_id;
    } catch (e: unknown) {
        if (env.verbose) console.error("[ERROR] Root memory creation failed:", e);
        await transaction.rollback();
        throw e;
    }
};

const createChildMemory = async (
    text: string,
    index: number,
    total: number,
    root_id: string,
    metadata?: Record<string, unknown>,
    user_id?: string | null,
) => {
    const result = await add_hsg_memory(
        text,
        j([]),
        {
            ...metadata,
            is_child: true,
            section_index: index,
            total_sections: total,
            parent_id: root_id,
        },
        user_id || undefined,
    );
    return result.id;
};

const link = async (
    rid: string,
    cid: string,
    idx: number,
    user_id?: string | null,
) => {
    const ts = now();
    await transaction.begin();
    try {
        await q.ins_waypoint.run(rid, cid, user_id || "anonymous", 1.0, ts, ts);
        await transaction.commit();
        if (env.verbose) {
            console.log(
                `[INGEST] Linked: ${rid.slice(0, 8)} -> ${cid.slice(0, 8)} (section ${idx})`,
            );
        }
    } catch (e: unknown) {
        await transaction.rollback();
        if (env.verbose) console.error(`[INGEST] Link failed for section ${idx}:`, e);
        throw e;
    }
};

/**
 * Ingests a raw document (text or buffer), optionally splitting it into generic chunks linked to a root memory.
 * @param t Raw text content (extracted or direct)
 * @param data Original data buffer (if applicable)
 * @param meta Additional metadata
 * @param cfg Configuration options (thresholds, force root)
 * @param user_id Owner of the memories
 */
export async function ingestDocument(
    t: string,
    data: string | Buffer,
    meta?: Record<string, unknown>,
    cfg?: ingestion_cfg,
    user_id?: string | null,
): Promise<IngestionResult> {
    const th = cfg?.lg_thresh || LG,
        sz = cfg?.sec_sz || SEC;
    const ex = await extractText(t, data);
    const { text, metadata: exMeta } = ex;
    const useRC = cfg?.force_root || exMeta.estimated_tokens > th;

    if (!useRC) {
        const r = await add_hsg_memory(
            text,
            j([]),
            {
                ...meta,
                ...exMeta,
                ingestion_strategy: "single",
                ingested_at: now(),
            },
            user_id || undefined,
        );
        return {
            root_memory_id: r.id,
            child_count: 0,
            total_tokens: exMeta.estimated_tokens,
            strategy: "single",
            extraction: exMeta,
        };
    }

    const secs = split(text, sz);
    if (env.verbose) {
        console.log(`[INGEST] Document: ${exMeta.estimated_tokens} tokens`);
        console.log(`[INGEST] Splitting into ${secs.length} sections`);
    }

    let root_id: string;
    const child_ids: string[] = [];

    try {
        root_id = await createRootMemory(text, ex, meta, user_id);
        if (env.verbose) console.log(`[INGEST] Root memory created: ${root_id}`);
        for (let i = 0; i < secs.length; i++) {
            try {
                const child_id = await createChildMemory(
                    secs[i],
                    i,
                    secs.length,
                    root_id,
                    meta,
                    user_id,
                );
                child_ids.push(child_id);
                await link(root_id, child_id, i, user_id);
                if (env.verbose) {
                    console.log(
                        `[INGEST] Section ${i + 1}/${secs.length} processed: ${child_id}`,
                    );
                }
            } catch (e: unknown) {
                if (env.verbose) {
                    console.error(
                        `[INGEST] Section ${i + 1}/${secs.length} failed:`,
                        e,
                    );
                }
                throw e;
            }
        }
        if (env.verbose) {
            console.log(
                `[INGEST] Completed: ${child_ids.length} sections linked to ${root_id}`,
            );
        }
        return {
            root_memory_id: root_id,
            child_count: secs.length,
            total_tokens: exMeta.estimated_tokens,
            strategy: "root-child",
            extraction: exMeta,
        };
    } catch (e: unknown) {
        if (env.verbose) console.error("[INGEST] Document ingestion failed:", e);
        throw e;
    }
}

/**
 * Ingests content from a URL by extracting text and metadata.
 * @param url The target URL
 * @param meta Additional metadata
 * @param cfg Configuration options
 * @param user_id Owner of the memories
 */
export async function ingestURL(
    url: string,
    meta?: Record<string, unknown>,
    cfg?: ingestion_cfg,
    user_id?: string | null,
): Promise<IngestionResult> {
    const { extractURL } = await import("./extract");
    const ex = await extractURL(url);
    const th = cfg?.lg_thresh || LG,
        sz = cfg?.sec_sz || SEC;
    const useRC = cfg?.force_root || ex.metadata.estimated_tokens > th;

    if (!useRC) {
        const r = await add_hsg_memory(
            ex.text,
            j([]),
            {
                ...meta,
                ...ex.metadata,
                ingestion_strategy: "single",
                ingested_at: now(),
            },
            user_id || undefined,
        );
        return {
            root_memory_id: r.id,
            child_count: 0,
            total_tokens: ex.metadata.estimated_tokens,
            strategy: "single",
            extraction: ex.metadata,
        };
    }

    const secs = split(ex.text, sz);
    if (env.verbose) {
        console.log(`[INGEST] URL: ${ex.metadata.estimated_tokens} tokens`);
        console.log(`[INGEST] Splitting into ${secs.length} sections`);
    }

    let root_id: string;
    const child_ids: string[] = [];

    try {
        root_id = await createRootMemory(ex.text, ex, { ...meta, source_url: url }, user_id);
        if (env.verbose) console.log(`[INGEST] Root memory for URL: ${root_id}`);
        for (let i = 0; i < secs.length; i++) {
            try {
                const child_id = await createChildMemory(
                    secs[i],
                    i,
                    secs.length,
                    root_id,
                    { ...meta, source_url: url },
                    user_id,
                );
                child_ids.push(child_id);
                await link(root_id, child_id, i, user_id);
                if (env.verbose) {
                    console.log(
                        `[INGEST] URL section ${i + 1}/${secs.length} processed: ${child_id}`,
                    );
                }
            } catch (e: unknown) {
                if (env.verbose) {
                    console.error(
                        `[INGEST] URL section ${i + 1}/${secs.length} failed:`,
                        e,
                    );
                }
                throw e;
            }
        }
        if (env.verbose) {
            console.log(
                `[INGEST] URL completed: ${child_ids.length} sections linked to ${root_id}`,
            );
        }
        return {
            root_memory_id: root_id,
            child_count: secs.length,
            total_tokens: ex.metadata.estimated_tokens,
            strategy: "root-child",
            extraction: ex.metadata,
        };
    } catch (e: unknown) {
        if (env.verbose) console.error("[INGEST] URL ingestion failed:", e);
        throw e;
    }
}

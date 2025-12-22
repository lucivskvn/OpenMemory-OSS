import { add_hsg_memory } from "../memory/hsg";
import { q, transaction } from "../core/db";
import { rid, now, j } from "../utils";
import { extractText, ExtractionResult } from "./extract";
import { log } from "../core/log";

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

const mkRoot = async (
    txt: string,
    ex: ExtractionResult,
    meta?: Record<string, unknown>,
    user_id?: string | null,
) => {
    const sum = txt.length > 500 ? txt.slice(0, 500) + "..." : txt;
    const cnt = `[Document: ${ex.metadata.content_type.toUpperCase()}]\n\n${sum}\n\n[Full content split across ${Math.ceil(txt.length / SEC)} sections]`;
    const id = rid(),
        ts = now();
    await transaction.begin();
    try {
        await q.ins_mem.run(
            id,
            user_id || "anonymous", // user_id
            0, // segment (default 0 for root)
            cnt, // content
            "", // simhash (not computed for root meta-doc yet, or should be?)
            "reflective", // primary_sector
            j([]), // tags
            j({
                ...meta,
                ...ex.metadata,
                is_root: true,
                ingestion_strategy: "root-child",
                ingested_at: ts,
            }), // meta
            ts, // created_at
            ts, // updated_at
            ts, // last_seen_at
            1.0, // salience
            0.1, // decay_lambda
            1, // version
            null, // mean_dim
            null, // mean_vec
            null, // compressed_vec
            0 // feedback_score
        );
        await transaction.commit();
        return id;
    } catch (e) {
        log.error("Root creation failed", { error: e });
        await transaction.rollback();
        throw e;
    }
};

const mkChild = async (
    txt: string,
    idx: number,
    tot: number,
    rid: string,
    meta?: Record<string, unknown>,
    user_id?: string | null,
) => {
    const r = await add_hsg_memory(
        txt,
        j([]),
        {
            ...meta,
            is_child: true,
            section_index: idx,
            total_sections: tot,
            parent_id: rid,
        },
        user_id || undefined,
    );
    return r.id;
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
        log.info(
            `Linked root to child`, { root: rid.slice(0, 8), child: cid.slice(0, 8), section: idx }
        );
    } catch (e) {
        await transaction.rollback();
        log.error(`Link failed for section`, { section: idx, error: e });
        throw e;
    }
};

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
    log.info("Ingesting document", { tokens: exMeta.estimated_tokens, sections: secs.length });

    let rid: string;
    const cids: string[] = [];

    try {
        rid = await mkRoot(text, ex, meta, user_id);
        log.info("Root memory created", { id: rid });
        for (let i = 0; i < secs.length; i++) {
            try {
                const cid = await mkChild(
                    secs[i],
                    i,
                    secs.length,
                    rid,
                    meta,
                    user_id,
                );
                cids.push(cid);
                await link(rid, cid, i, user_id);
                log.info(
                    `Section processed`, { index: i + 1, total: secs.length, id: cid }
                );
            } catch (e) {
                log.error(
                    `Section processing failed`, { index: i + 1, total: secs.length, error: e }
                );
                throw e;
            }
        }
        log.info(
            "Ingestion completed", { root: rid, child_count: cids.length }
        );
        return {
            root_memory_id: rid,
            child_count: secs.length,
            total_tokens: exMeta.estimated_tokens,
            strategy: "root-child",
            extraction: exMeta,
        };
    } catch (e) {
        log.error("Document ingestion failed", { error: e });
        throw e;
    }
}

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
    log.info("Ingesting URL", { url, tokens: ex.metadata.estimated_tokens, sections: secs.length });

    let rid: string;
    const cids: string[] = [];

    try {
        rid = await mkRoot(ex.text, ex, { ...meta, source_url: url }, user_id);
        log.info("Root memory created for URL", { id: rid });
        for (let i = 0; i < secs.length; i++) {
            try {
                const cid = await mkChild(
                    secs[i],
                    i,
                    secs.length,
                    rid,
                    { ...meta, source_url: url },
                    user_id,
                );
                cids.push(cid);
                await link(rid, cid, i, user_id);
                log.info(
                    `URL Section processed`, { index: i + 1, total: secs.length, id: cid }
                );
            } catch (e) {
                log.error(
                    `URL Section processing failed`, { index: i + 1, total: secs.length, error: e }
                );
                throw e;
            }
        }
        log.info(
            "URL Ingestion completed", { root: rid, child_count: cids.length }
        );
        return {
            root_memory_id: rid,
            child_count: secs.length,
            total_tokens: ex.metadata.estimated_tokens,
            strategy: "root-child",
            extraction: ex.metadata,
        };
    } catch (e) {
        log.error("URL ingestion failed", { error: e });
        throw e;
    }
}

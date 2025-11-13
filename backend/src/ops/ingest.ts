import { add_hsg_memory } from "../memory/hsg";
import { q, transaction } from "../core/db";
import { rid, now, j } from "../utils";
import { extractText, ExtractionResult } from "./extract";
import logger from "../core/logger";

const LG = 8000,
    SEC = 3000;

export interface ingestion_cfg {
    force_root?: boolean;
    sec_sz?: number;
    lg_thresh?: number;
    // Optional override for max ingest size in megabytes
    max_size_mb?: number;
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
    const _transaction = (ingestDocument as any)._transaction || transaction;
    const _q = (ingestDocument as any)._q || q;
    await _transaction.begin();
    try {
        // canonical 18-arg ins_mem: (id, user_id, segment, content, simhash, primary_sector, tags, meta, created_at, updated_at, last_seen_at, salience, decay_lambda, version, mean_dim, mean_vec, compressed_vec, feedback_score)
        await _q.ins_mem.run(
            id,
            user_id || null,
            0,
            cnt,
            "",
            "reflective",
            j([]),
            j({
                ...meta,
                ...ex.metadata,
                is_root: true,
                ingestion_strategy: "root-child",
                ingested_at: ts,
            }),
            ts,
            ts,
            ts,
            1.0,
            0.1,
            1,
            0,
            Buffer.alloc(0),
            Buffer.alloc(0),
            0,
        );
        await _transaction.commit();
        return id;
    } catch (e) {
        logger.error({ component: "INGEST", err: e }, "[INGEST] Root failed: %o", e);
        await _transaction.rollback();
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
    const _transaction = (ingestDocument as any)._transaction || transaction;
    const _q = (ingestDocument as any)._q || q;
    await _transaction.begin();
    try {
        await _q.ins_waypoint.run(rid, cid, user_id || null, 1.0, ts, ts);
        await _transaction.commit();
        logger.info({ component: "INGEST" }, "[INGEST] Linked: %s -> %s (section %d)", rid.slice(0, 8), cid.slice(0, 8), idx);
    } catch (e) {
        await _transaction.rollback();
        logger.error({ component: "INGEST", err: e }, "[INGEST] Link failed for section %d: %o", idx, e);
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
    // Testing seam: allow tests to override the ingest pipeline.
    if ((ingestDocument as any)._mock) return await (ingestDocument as any)._mock(t, data, meta, cfg, user_id);
    const th = cfg?.lg_thresh || LG,
        sz = cfg?.sec_sz || SEC;
    const ex = await extractText(t, data);
    const { text, metadata: exMeta } = ex;
    const useRC = cfg?.force_root || exMeta.estimated_tokens > th;

    if (!useRC) {
        // allow tests to override the HSG insertion logic via a seam
        const _add_hsg_memory = (ingestDocument as any)._add_hsg_memory || add_hsg_memory;
        const r = await _add_hsg_memory(
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
    logger.info({ component: "INGEST", tokens: exMeta.estimated_tokens }, "[INGEST] Document: %d tokens", exMeta.estimated_tokens);
    logger.info({ component: "INGEST", sections: secs.length }, "[INGEST] Splitting into %d sections", secs.length);

    let rid: string;
    const cids: string[] = [];

    try {
        rid = await mkRoot(text, ex, meta, user_id);
        logger.info({ component: "INGEST", root: rid }, "[INGEST] Root memory created: %s", rid);
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
                logger.info({ component: "INGEST", section: i + 1, total_sections: secs.length, id: cid }, "[INGEST] Section %d/%d processed: %s", i + 1, secs.length, cid);
            } catch (e) {
                logger.error({ component: "INGEST", err: e }, "[INGEST] Section %d/%d failed: %o", i + 1, secs.length, e);
                throw e;
            }
        }
        logger.info({ component: "INGEST", root: rid, linked: cids.length }, "[INGEST] Completed: %d sections linked to %s", cids.length, rid);
        return {
            root_memory_id: rid,
            child_count: secs.length,
            total_tokens: exMeta.estimated_tokens,
            strategy: "root-child",
            extraction: exMeta,
        };
    } catch (e) {
        logger.error({ component: "INGEST", err: e }, "[INGEST] Document ingestion failed: %o", e);
        throw e;
    }
}

// Test seam to set a mock implementation for ingestDocument.
export function setIngestDocumentForTests(mock: (t: string, data: string | Buffer, meta?: Record<string, unknown>, cfg?: ingestion_cfg, user_id?: string | null) => Promise<IngestionResult>) {
    (ingestDocument as any)._mock = mock;
}

// File-based ingestion helper that uses Bun.file() for faster I/O
export async function ingestDocumentFromFile(
    filePath: string,
    contentType: string,
    meta?: Record<string, unknown>,
    cfg?: ingestion_cfg,
    user_id?: string | null,
): Promise<IngestionResult> {
    const start = Date.now();
    try {
        // Prefer non-blocking Bun.file() operations instead of synchronous fs calls.
        const f = Bun.file(filePath);
        const exists = await f.exists();
        if (!exists) throw new Error('File not found');
        // Try to obtain a size without reading the whole file when possible.
        let fileSize: number | undefined = undefined;
        try {
            // Bun may expose a numeric `size` property; handle Promise or number.
            const maybeSize: any = (f as any).size;
            if (typeof maybeSize === 'number') fileSize = maybeSize;
            else if (maybeSize && typeof maybeSize.then === 'function') fileSize = await maybeSize;
        } catch (_) {
            // ignore, we'll fallback to detecting size later
        }
        // Bun.file().type is best-effort; call it now
        const mimeType = (f as any).type;
        // Determine max size: priority: cfg param -> env var -> default 200 MB
        const envMax = Number(process.env.OM_INGEST_MAX_SIZE_MB || '') || undefined;
        const maxMb = cfg?.max_size_mb ?? envMax ?? 200;
        const maxBytes = maxMb * 1024 * 1024;

        // If we have a size reported by Bun, enforce it immediately.
        if (fileSize && fileSize > maxBytes) {
            const err: any = new Error('File too large');
            err.code = 'ERR_FILE_TOO_LARGE';
            err.name = 'FileTooLargeError';
            throw err;
        }

        // If Bun.file() didn't expose a size we must read the file in chunks and
        // abort early if it exceeds the configured max. This avoids reading an
        // entire huge file into memory before checking size.
        let buffer: Buffer;
        if (fileSize === undefined) {
                // Try a small prefix read to allow lightweight type/sniff checks.
            const reader = (f as any).stream ? (f as any).stream().getReader() : null;
                if (reader) {
                const chunks: Uint8Array[] = [];
                let total = 0;
                let streamTruncated = false;
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
                        if (chunk && chunk.length) {
                            chunks.push(chunk);
                            total += chunk.length;
                            if (total > maxBytes) {
                                // cancel the reader to free resources
                                try { await reader.cancel(); } catch (_) { }
                                const err: any = new Error('File too large');
                                err.code = 'ERR_FILE_TOO_LARGE';
                                err.name = 'FileTooLargeError';
                                throw err;
                            }
                            // If we've read a small prefix sufficient for MIME sniffing,
                            // break early to avoid reading the entire file into memory here.
                            if (total >= 4096) {
                                streamTruncated = true;
                                try { await reader.cancel(); } catch (_) { }
                                break;
                            }
                        }
                    }
                } catch (e) {
                    // If the stream read failed for any reason, fall back to arrayBuffer
                    // below which will also enforce size.
                    // (no-op here; we'll take the arrayBuffer path next)
                }
                // If we only read a prefix for sniffing, perform a full read now to
                // obtain the complete contents (and re-check size limits).
                if (streamTruncated) {
                    const arr = await f.arrayBuffer();
                    const fullSize = arr.byteLength;
                    if (fullSize > maxBytes) {
                        const err: any = new Error('File too large');
                        err.code = 'ERR_FILE_TOO_LARGE';
                        err.name = 'FileTooLargeError';
                        throw err;
                    }
                    buffer = Buffer.from(arr);
                    fileSize = fullSize;
                } else {
                // concatenate chunks into one Uint8Array (always copy to create a plain ArrayBuffer)
                let arrBuf: ArrayBuffer;
                if (chunks.length === 0) {
                    arrBuf = new ArrayBuffer(0);
                } else {
                    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
                    const out = new Uint8Array(totalLen);
                    let offset = 0;
                    for (const c of chunks) {
                        out.set(c, offset);
                        offset += c.length;
                    }
                    arrBuf = out.buffer;
                }
                // Enforce size after streaming/concatenation (total is tracked above)
                if (total > maxBytes) {
                    const err: any = new Error('File too large');
                    err.code = 'ERR_FILE_TOO_LARGE';
                    err.name = 'FileTooLargeError';
                    throw err;
                }
                buffer = Buffer.from(arrBuf);
                fileSize = total;
                }
            } else {
                // No stream support detected - fall back to arrayBuffer() but still
                // enforce maxBytes after reading the ArrayBuffer but before converting
                // to a Buffer to avoid extra memory pressure.
                const arr = await f.arrayBuffer();
                fileSize = arr.byteLength;
                if (fileSize > maxBytes) {
                    const err: any = new Error('File too large');
                    err.code = 'ERR_FILE_TOO_LARGE';
                    err.name = 'FileTooLargeError';
                    throw err;
                }
                buffer = Buffer.from(arr);
            }
        } else {
            // fileSize known and within limits; do a single arrayBuffer read and convert
            const arr = await f.arrayBuffer();
            // Double-check in case size changed between stat and read
            if (arr.byteLength > maxBytes) {
                const err: any = new Error('File too large');
                err.code = 'ERR_FILE_TOO_LARGE';
                err.name = 'FileTooLargeError';
                throw err;
            }
            buffer = Buffer.from(arr);
        }
        // Log detected MIME type from Bun.file() to aid debugging and validation
        logger.info({ component: 'INGEST', file: filePath, size: fileSize, mime: mimeType }, `[INGEST] Processing file: ${filePath} size: ${fileSize} mime: ${mimeType}`);
        // Optional quick validation: if a contentType was provided and it disagrees with Bun's
        // detected type, log a warning so callers can see potential mismatches. Compare
        // normalized MIME types (split on ';') to avoid false positives when charsets are present.
        const normProvided = (contentType || '').split(';')[0].trim().toLowerCase();
        const normDetected = (mimeType || '').split(';')[0].trim().toLowerCase();
        if (normProvided && normDetected && normProvided !== normDetected) {
            // Surface potential user misconfigurations at WARN level so they are more visible
            logger.warn({ component: 'INGEST', file: filePath, provided: contentType, detected: mimeType }, `[INGEST] Provided contentType '%s' differs from detected mime '%s'`, contentType, mimeType);
        }
        // If contentType is missing or generic, prefer the detected mime type from Bun.file()
        let effectiveType = contentType;
        if (!effectiveType || effectiveType === 'application/octet-stream') {
            effectiveType = mimeType || effectiveType;
        }
        // If both provided contentType and Bun.file().type are absent, try to infer from extension
        if (!effectiveType) {
            const p = filePath.toLowerCase();
            if (p.endsWith('.pdf')) effectiveType = 'application/pdf';
            else if (p.endsWith('.docx')) effectiveType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            else if (p.endsWith('.doc')) effectiveType = 'application/msword';
            else if (p.endsWith('.html') || p.endsWith('.htm')) effectiveType = 'text/html';
            else if (p.endsWith('.md') || p.endsWith('.markdown')) effectiveType = 'text/markdown';
            else if (p.endsWith('.txt')) effectiveType = 'text/plain';
            else effectiveType = 'application/octet-stream';
        }
        // Keep existing mismatch warning when both are present and differ
        const result = await ingestDocument(effectiveType, buffer, meta, cfg, user_id);
        logger.info({ component: 'INGEST', file: filePath, duration: Date.now() - start }, `[INGEST] Completed ingestion for ${filePath} in ${Date.now() - start}ms`);
        return result;
    } catch (e) {
        logger.error({ component: 'INGEST', file: filePath, err: e }, `[INGEST] File ingestion failed for ${filePath}: %o`, e);
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
    logger.info({ component: "INGEST", tokens: ex.metadata.estimated_tokens }, "[INGEST] URL: %d tokens", ex.metadata.estimated_tokens);
    logger.info({ component: "INGEST", sections: secs.length }, "[INGEST] Splitting into %d sections", secs.length);

    let rid: string;
    const cids: string[] = [];

    try {
        rid = await mkRoot(ex.text, ex, { ...meta, source_url: url }, user_id);
        logger.info({ component: "INGEST", root: rid }, "[INGEST] Root memory for URL: %s", rid);
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
                logger.info({ component: "INGEST", section: i + 1, total_sections: secs.length, id: cid }, "[INGEST] URL section %d/%d processed: %s", i + 1, secs.length, cid);
            } catch (e) {
                logger.error({ component: "INGEST", err: e }, "[INGEST] URL section %d/%d failed: %o", i + 1, secs.length, e);
                throw e;
            }
        }
        logger.info({ component: "INGEST", root: rid, linked: cids.length }, "[INGEST] URL completed: %d sections linked to %s", cids.length, rid);
        return {
            root_memory_id: rid,
            child_count: secs.length,
            total_tokens: ex.metadata.estimated_tokens,
            strategy: "root-child",
            extraction: ex.metadata,
        };
    } catch (e) {
        logger.error({ component: "INGEST", err: e }, "[INGEST] URL ingestion failed: %o", e);
        throw e;
    }
}

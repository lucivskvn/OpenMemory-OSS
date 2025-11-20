import { add_hsg_memory } from "../memory/hsg";
import { q, transaction } from "../core/db";
import { rid, now, j } from "../utils";
import { extractText, ExtractionResult } from "./extract";
import logger from "../core/logger";
import { getNormalizedFileSize, logFileProcessing } from "../utils/file";
import { addTemporalTag, extractTemporalMetadata } from "../temporal/temporal";

const LG = 8000,
    SEC = 3000;

export interface ingestion_cfg {
    force_root?: boolean;
    sec_sz?: number;
    lg_thresh?: number;
    // Optional override for max ingest size in megabytes
    max_size_mb?: number;
    // Optional: prefer Bun-detected MIME over provided contentType when provided type is likely wrong
    prefer_detected_mime?: boolean;
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
        logger.error({ component: "INGEST", err: e }, "Root failed");
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
        logger.info({ component: "INGEST", root: rid.slice(0, 8), child: cid.slice(0, 8), section: idx }, "Linked");
    } catch (e) {
        await _transaction.rollback();
        logger.error({ component: "INGEST", err: e, section: idx }, "Link failed");
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
    logger.info({ component: "INGEST", tokens: exMeta.estimated_tokens }, "Document token count");
    logger.info({ component: "INGEST", sections: secs.length }, "Splitting into sections");

    let rid: string;
    const cids: string[] = [];

    try {
        rid = await mkRoot(text, ex, meta, user_id);
        logger.info({ component: "INGEST", root: rid }, "Root memory created");
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
                logger.info({ component: "INGEST", section: i + 1, total_sections: secs.length, id: cid }, "Section processed");
            } catch (e) {
                logger.error({ component: "INGEST", err: e, section: i + 1, total_sections: secs.length }, "Section failed");
                throw e;
            }
        }
        logger.info({ component: "INGEST", root: rid, linked: cids.length }, "Completed sections linked");
        return {
            root_memory_id: rid,
            child_count: secs.length,
            total_tokens: exMeta.estimated_tokens,
            strategy: "root-child",
            extraction: exMeta,
        };
    } catch (e) {
        logger.error({ component: "INGEST", err: e }, "Document ingestion failed");
        throw e;
    }
}

// Test seam to set a mock implementation for ingestDocument.
export function setIngestDocumentForTests(mock?: ((t: string, data: string | Buffer, meta?: Record<string, unknown>, cfg?: ingestion_cfg, user_id?: string | null) => Promise<IngestionResult>) | null) {
    // Accept `null`/`undefined` to clear the seam so tests don't leak
    // their mocked behavior to other tests that reuse the module.
    if (mock === undefined || mock === null) {
        delete (ingestDocument as any)._mock;
        return;
    }
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
        // Normalize file size (Bun may expose `size` as number or Promise)
        let fileSize = await getNormalizedFileSize(f);
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

        // If Bun.file() didn't expose a size (null or undefined) we must read the
        // file in chunks and abort early if it exceeds the configured max. This
        // avoids reading an entire huge file into memory before checking size.
        let buffer: Buffer;
        // treat both `null` and `undefined` as missing size
        if (fileSize == null) {
        // Try a small prefix read to allow lightweight type/sniff checks.
            const reader = (f as any).stream ? (f as any).stream().getReader() : null;
            if (reader) {
                // Read the entire stream in a single pass (no double-read). Enforce
                // maxBytes while streaming to avoid excessive memory use.
                const chunks: Uint8Array[] = [];
                let total = 0;
                let streamOk = false;
                try {
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) {
                            streamOk = true;
                            break;
                        }
                        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
                        if (chunk && chunk.length) {
                            chunks.push(chunk);
                            total += chunk.length;
                            if (total > maxBytes) {
                                try { await reader.cancel(); } catch (_) { }
                                const err: any = new Error('File too large');
                                err.code = 'ERR_FILE_TOO_LARGE';
                                err.name = 'FileTooLargeError';
                                throw err;
                            }
                        }
                    }
                } catch (e) {
                    // Streaming read failed; best-effort cancel and fall back to arrayBuffer
                    try { await reader.cancel(); } catch (_) { }
                }

                if (streamOk) {
                    // concatenate chunks into one ArrayBuffer only when stream succeeded
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
                    // total is tracked above
                    if (total > maxBytes) {
                        const err: any = new Error('File too large');
                        err.code = 'ERR_FILE_TOO_LARGE';
                        err.name = 'FileTooLargeError';
                        throw err;
                    }
                    buffer = Buffer.from(arrBuf);
                    fileSize = total;
                } else {
                    // Streaming failed; fallback to arrayBuffer and enforce limits there
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
        logFileProcessing("INGEST", filePath, fileSize, mimeType, "bun-file");
        // Optional quick validation: if a contentType was provided and it disagrees with Bun's
        // detected type, log a warning so callers can see potential mismatches. Compare
        // normalized MIME types (split on ';') to avoid false positives when charsets are present.
        const normProvided = (contentType || '').split(';')[0].trim().toLowerCase();
        const normDetected = (mimeType || '').split(';')[0].trim().toLowerCase();
        if (normProvided && normDetected && normProvided !== normDetected) {
            // Surface potential user misconfigurations at WARN level so they are more visible
            logger.warn({ component: 'INGEST', file: filePath, provided: contentType, detected: mimeType }, 'Provided contentType differs from detected mime');
        }
        // If contentType is missing or generic, prefer the detected mime type from Bun.file()
        let effectiveType = contentType;
        if (!effectiveType || effectiveType === 'application/octet-stream') {
            effectiveType = mimeType || effectiveType;
        }
        // Optional opt-in: prefer detected MIME when provided type is a generic text/* but detected is a stronger type
        const preferDetected = cfg?.prefer_detected_mime || (process.env.OM_INGEST_PREFER_DETECTED || '').toLowerCase() === 'true';
        if (preferDetected && normProvided.startsWith('text') && normDetected) {
            const preferSet = new Set([
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'text/html',
            ]);
            if (preferSet.has(normDetected)) {
                effectiveType = normDetected;
                logger.info({ component: 'INGEST', file: filePath, provided: contentType, detected: mimeType }, 'Overriding provided contentType with detected MIME since prefer_detected_mime is enabled');
            }
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
        logger.info({ component: 'INGEST', file: filePath, duration: Date.now() - start }, 'Completed ingestion');

        // Temporal tagging integration: currently an in-memory/logging stub.
        // Persistence will be wired in a later phase where temporal metadata
        // is stored in the database alongside memory objects.
        // Integrate temporal tagging for multi-modal content
        const isMultiModal = effectiveType.startsWith("image/") || effectiveType.startsWith("audio/") || effectiveType.startsWith("video/");
        if (isMultiModal) {
            const temporalMetadata = extractTemporalMetadata(effectiveType, buffer.buffer);
            if (temporalMetadata) {
                // Find the main memory object to tag (assuming single strategy for multi-modal)
                // In a full implementation, this would need to handle root-child strategy as well
                if (result.strategy === "single") {
                    const memoryObject = {
                        id: result.root_memory_id,
                        metadata: { ...result.extraction }
                    };
                    // Add temporal tag (this is a simplified integration - full implementation would persist)
                    addTemporalTag(memoryObject, temporalMetadata);
                    logger.info({ component: 'INGEST', temporalType: temporalMetadata.type }, 'Temporal tag attached to multi-modal content');
                }
            }
        }

        return result;
    } catch (e) {
        logger.error({ component: 'INGEST', file: filePath, err: e }, 'File ingestion failed');
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
    logger.info({ component: "INGEST", tokens: ex.metadata.estimated_tokens }, "URL token count");
    logger.info({ component: "INGEST", sections: secs.length }, "Splitting into sections");

    let rid: string;
    const cids: string[] = [];

    try {
        rid = await mkRoot(ex.text, ex, { ...meta, source_url: url }, user_id);
        logger.info({ component: "INGEST", root: rid }, "Root memory for URL created");
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
                logger.info({ component: "INGEST", section: i + 1, total_sections: secs.length, id: cid }, "URL section processed");
            } catch (e) {
                logger.error({ component: "INGEST", err: e, section: i + 1, total_sections: secs.length }, "URL section failed");
                throw e;
            }
        }
        logger.info({ component: "INGEST", root: rid, linked: cids.length }, "URL completed sections linked");
        return {
            root_memory_id: rid,
            child_count: secs.length,
            total_tokens: ex.metadata.estimated_tokens,
            strategy: "root-child",
            extraction: ex.metadata,
        };
    } catch (e) {
        logger.error({ component: "INGEST", err: e }, "URL ingestion failed");
        throw e;
    }
}

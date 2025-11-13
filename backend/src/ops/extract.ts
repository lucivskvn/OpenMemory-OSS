import mammoth from "mammoth";
import TurndownService from "turndown";
import logger from "../core/logger";

// Minimal, robust extraction helpers used by tests. This file intentionally
// keeps implementations small and adds test seams so unit tests can inject
// parser mocks rather than depending on heavy native parsers.

export interface ExtractionResult {
    text: string;
    metadata: {
        content_type: string;
        char_count: number;
        estimated_tokens: number;
        extraction_method: string;
        [key: string]: any;
    };
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// Test seams
let _mammoth: any = mammoth;
export function setMammothForTests(mock: any) {
    _mammoth = mock;
}

let _pdfParseImpl: any = null;
export function setPdfParseForTests(mockImpl: any) {
    _pdfParseImpl = mockImpl;
}

// Testing seam for extractText
export function setExtractTextForTests(mock: (ct: string, data: any, isBase64?: boolean) => Promise<ExtractionResult>) {
    (extractText as any)._mock = mock;
}

async function loadPdfParseImpl(): Promise<any> {
    if (_pdfParseImpl) return _pdfParseImpl;
    try {
        const mod = await import("pdf-parse");
        return (mod && (mod as any).default) || mod;
    } catch (e) {
        // pdf-parse not available — tests should inject a mock when needed
        return null;
    }
}

export async function extractPDF(buffer: Buffer): Promise<ExtractionResult> {
    const impl = await loadPdfParseImpl();
    // If a parser isn't available, fall back to a UTF-8 passthrough to keep tests deterministic
    if (!impl) {
        const text = buffer.toString('utf8');
        return {
            text,
            metadata: {
                content_type: 'pdf',
                char_count: text.length,
                estimated_tokens: estimateTokens(text),
                extraction_method: 'passthrough',
            },
        };
    }

    // If impl is a function that accepts a buffer and returns { text }
    if (typeof impl === 'function') {
        const result = await impl(buffer);
        const text = result?.text ?? '';
        return {
            text,
            metadata: {
                content_type: 'pdf',
                char_count: text.length,
                estimated_tokens: estimateTokens(text),
                extraction_method: 'pdf-parse',
            },
        };
    }

    // Unknown shape: fallback
    return {
        text: buffer.toString('utf8'),
        metadata: {
            content_type: 'pdf',
            char_count: buffer.length,
            estimated_tokens: estimateTokens(buffer.toString('utf8')),
            extraction_method: 'unknown',
        },
    };
}

export async function extractDOCX(buffer: Buffer): Promise<ExtractionResult> {
    // Use mammoth (or test-provided mock) to extract raw text; fall back to passthrough
    try {
        if (_mammoth && typeof _mammoth.extractRawText === 'function') {
            const result = await _mammoth.extractRawText({ buffer });
            const text = result?.value ?? '';
            return {
                text,
                metadata: {
                    content_type: 'docx',
                    char_count: text.length,
                    estimated_tokens: estimateTokens(text),
                    extraction_method: 'mammoth',
                },
            };
        }
    } catch (e) {
        // fall through to passthrough
    }
    const text = buffer.toString('utf8');
    return {
        text,
        metadata: {
            content_type: 'docx',
            char_count: text.length,
            estimated_tokens: estimateTokens(text),
            extraction_method: 'passthrough',
        },
    };
}

export async function extractHTML(html: string): Promise<ExtractionResult> {
    const turndown = new (TurndownService as any)({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const markdown = turndown.turndown(html);
    return {
        text: markdown,
        metadata: {
            content_type: 'html',
            char_count: markdown.length,
            estimated_tokens: estimateTokens(markdown),
            extraction_method: 'turndown',
        },
    };
}

export async function extractURL(url: string, userId?: string): Promise<ExtractionResult> {
    // Minimal fetch+turndown implementation with basic SSRF checks already handled elsewhere.
    const start = Date.now();
    // Enforce a bounded fetch to avoid hanging requests. Use AbortController with 30s timeout.
    const controller = new AbortController();
    const timeout = 30000; // 30 seconds
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
        response = await fetch(url, { signal: controller.signal } as any);
    } catch (e: any) {
        // Distinguish aborts so callers can log/handle timeouts distinctly
        if (e && e.name === 'AbortError') {
            throw new Error('Fetch aborted: timeout');
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const html = await response.text();

    const turndown = new (TurndownService as any)({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const markdown = turndown.turndown(html);

    return {
        text: markdown,
        metadata: {
            content_type: 'url',
            char_count: markdown.length,
            estimated_tokens: estimateTokens(markdown),
            extraction_method: 'fetch+turndown',
            source_url: url,
            user_id: userId || null,
            fetched_at: new Date().toISOString(),
            fetch_duration_ms: Date.now() - start,
            http_status: response.status,
        },
    };
}

export async function extractText(contentType: string, data: string | Buffer | ArrayBuffer | Uint8Array, isBase64?: boolean): Promise<ExtractionResult> {
    // Testing seam
    if ((extractText as any)._mock) return await (extractText as any)._mock(contentType, data, isBase64);

    let ct = (contentType || '').toLowerCase().trim();
    if (ct.includes(';')) ct = ct.split(';')[0].trim();
    const mimeMap: Record<string, string> = {
        'application/pdf': 'pdf',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'text/html': 'html',
        'application/xhtml+xml': 'html',
        'text/plain': 'text',
        'text/markdown': 'markdown',
        'text/x-markdown': 'markdown',
        'application/rtf': 'text',
        // Do NOT default generic octet-stream to PDF. We'll perform a
        // lightweight magic-bytes check below: only treat octet-stream as
        // PDF if the buffer begins with the PDF signature. Otherwise throw
        // an unsupported content type error to avoid misclassifying unknown
        // binaries.
    };
    if (mimeMap[ct]) ct = mimeMap[ct];

    const textTypes = new Set(['html', 'htm', 'markdown', 'md', 'txt', 'text']);
    const binaryTypes = new Set(['pdf', 'doc', 'docx']);

    let buffer: Buffer;
    if (typeof data === 'string') {
        if (isBase64 === true || binaryTypes.has(ct)) {
            buffer = Buffer.from(data, 'base64');
        } else {
            buffer = Buffer.from(data, 'utf8');
        }
    } else if (ArrayBuffer.isView(data)) {
        const view: any = data as ArrayBufferView;
        buffer = Buffer.from(view.buffer, view.byteOffset || 0, view.byteLength || undefined);
    } else if ((data as any) instanceof ArrayBuffer) {
        buffer = Buffer.from(data as ArrayBuffer);
    } else {
        buffer = Buffer.from(data as any);
    }

    // Log a quick comparison between raw bytes and decoded characters to help
    // surface discrepancies for multi-byte/Unicode text in production. We decode
    // a small preview (full decode is cheap compared to parsing) to compute
    // the character count used by downstream metadata.
    try {
        const preview = buffer.toString('utf8');
        logger.debug({ component: 'EXTRACT', bytes: buffer.byteLength, chars: preview.length }, 'Buffer vs char count');
    } catch (e) {
        // Non-fatal: logging failure shouldn't block extraction
        logger.debug({ component: 'EXTRACT', bytes: buffer.byteLength, err: String(e) }, 'Buffer decode failed for char count');
    }

    // If the caller provided a generic application/octet-stream, try a
    // minimal magic-bytes check after we have a buffer to avoid guessing
    // based only on content-type. This prevents accidentally treating
    // arbitrary binaries as PDFs. We also allow an opt-in legacy fallback
    // (`OM_ACCEPT_OCTET_LEGACY=true`) that will attempt to decode the
    // octet-stream as UTF-8 text for backward compatibility with some
    // clients — this is opt-in because it can misclassify binary files.
    if (ct === 'application/octet-stream') {
        // Check PDF signature: %PDF- at the start
        const sig4 = buffer.slice(0, 4);
        const isPdf = sig4.length >= 4 && sig4.toString('utf8', 0, 4) === '%PDF';
        // Check ZIP-based DOCX signature: PK\x03\x04
        const isZip = sig4.length >= 4 && sig4[0] === 0x50 && sig4[1] === 0x4b && sig4[2] === 0x03 && sig4[3] === 0x04;
        if (isPdf) {
            ct = 'pdf';
        } else if (isZip) {
            // ZIP container is commonly used for DOCX files; prefer docx
            ct = 'docx';
        } else if (process.env.OM_ACCEPT_OCTET_LEGACY === 'true') {
            // Legacy permissive mode: attempt to treat octet-stream as UTF-8 text
            try {
                const maybe = buffer.toString('utf8');
                // cheap sanity check: if the decoded string has reasonable printable content,
                // treat it as text. This is intentionally permissive for backward compatibility.
                const printableRatio = (maybe.replace(/\s/g, '').replace(/[^\x20-\x7E]/g, '').length) / Math.max(1, maybe.length);
                if (printableRatio > 0.2) ct = 'text';
                else throw new Error('Octet legacy decode produced non-text-like payload');
            } catch (e) {
                throw new Error(`Unsupported content type: ${contentType}`);
            }
        } else {
            // Log guidance for operators: suggest opt-in legacy flag when clients send
            // generic `application/octet-stream` without recognizable magic bytes.
            logger.warn({ component: 'EXTRACT', content_type: contentType }, "Unsupported octet-stream detected; set OM_ACCEPT_OCTET_LEGACY=true to permissively accept octet-stream as text (opt-in, may misclassify binaries)");
            throw new Error(`Unsupported content type: ${contentType}`);
        }
    }

    switch (ct) {
        case 'pdf':
            return extractPDF(buffer);
        case 'docx':
        case 'doc':
            return extractDOCX(buffer);
        case 'html':
        case 'htm':
            return extractHTML(buffer.toString('utf8'));
        case 'md':
        case 'markdown':
            {
                const str = buffer.toString('utf8');
                return {
                    text: str,
                    metadata: {
                        content_type: 'markdown',
                        char_count: str.length,
                        estimated_tokens: estimateTokens(str),
                        extraction_method: 'passthrough',
                    },
                };
            }
        case 'txt':
        case 'text':
            {
                const str = buffer.toString('utf8');
                return {
                    text: str,
                    metadata: {
                        content_type: 'text',
                        char_count: str.length,
                        estimated_tokens: estimateTokens(str),
                        extraction_method: 'passthrough',
                    },
                };
            }
        default:
            throw new Error(`Unsupported content type: ${contentType}`);
    }
}

// File helpers
export async function extractPDFFromFile(filePath: string): Promise<ExtractionResult> {
    const start = Date.now();
    try {
        const f = Bun.file(filePath);
        const exists = await f.exists();
        if (!exists) throw new Error('File not found');
        // Bun.file.size may be undefined or a promise on some platforms; normalize to a number or null
        let fileSize: number | null = null;
        try {
            const maybeSize: any = (f as any).size;
            if (typeof maybeSize === 'number') fileSize = maybeSize;
            else if (maybeSize && typeof maybeSize.then === 'function') {
                try { fileSize = await maybeSize; } catch { fileSize = null; }
            } else fileSize = null;
        } catch (_err) {
            fileSize = null;
        }
        logger.info('[EXTRACT] Processing file', { filePath, file_size_bytes: fileSize, method: 'bun-file' });

        const arr = await f.arrayBuffer();
        const buffer = Buffer.from(arr);
        const result = await extractPDF(buffer);

        const duration = Date.now() - start;
        // Add observability fields into metadata and log
        result.metadata = {
            ...result.metadata,
            extraction_duration_ms: duration,
            file_size_bytes: fileSize,
            extraction_method: result.metadata.extraction_method || 'pdf-parse',
        };
        logger.info('[EXTRACT] Completed', { filePath, duration_ms: duration, file_size_bytes: fileSize, method: 'bun-file' });
        return result;
    } catch (e: any) {
        const duration = Date.now() - start;
        logger.error('[EXTRACT] Failed to process file', { filePath, error: e?.message ?? String(e), duration_ms: duration });
        throw e;
    }
}

export async function extractDOCXFromFile(filePath: string): Promise<ExtractionResult> {
    const start = Date.now();
    try {
        const f = Bun.file(filePath);
        const exists = await f.exists();
        if (!exists) throw new Error('File not found');
        // Bun.file.size may be undefined or a promise on some platforms; normalize to a number or null
        let fileSize: number | null = null;
        try {
            const maybeSize: any = (f as any).size;
            if (typeof maybeSize === 'number') fileSize = maybeSize;
            else if (maybeSize && typeof maybeSize.then === 'function') {
                try { fileSize = await maybeSize; } catch { fileSize = null; }
            } else fileSize = null;
        } catch (_err) {
            fileSize = null;
        }
        logger.info('[EXTRACT] Processing file', { filePath, file_size_bytes: fileSize, method: 'bun-file' });

        const arr = await f.arrayBuffer();
        const buffer = Buffer.from(arr);
        const result = await extractDOCX(buffer);

        const duration = Date.now() - start;
        result.metadata = {
            ...result.metadata,
            extraction_duration_ms: duration,
            file_size_bytes: fileSize,
            extraction_method: result.metadata.extraction_method || 'mammoth',
        };
        logger.info('[EXTRACT] Completed', { filePath, duration_ms: duration, file_size_bytes: fileSize, method: 'bun-file' });
        return result;
    } catch (e: any) {
        const duration = Date.now() - start;
        logger.error('[EXTRACT] Failed to process file', { filePath, error: e?.message ?? String(e), duration_ms: duration });
        throw e;
    }
}


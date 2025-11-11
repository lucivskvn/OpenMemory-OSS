import mammoth from "mammoth";
const TurndownService = require("turndown");

// Helper utilities for URL validation / SSRF protections
function isIPv4(host: string) {
    const parts = host.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => {
        const n = Number(p);
        return Number.isInteger(n) && n >= 0 && n <= 255;
    });
}

function isIPv6(host: string) {
    // crude check for presence of ':'
    return host.includes(":");
}

function ipv4ToInt(host: string) {
    const p = host.split('.').map((x) => Number(x) || 0);
    return ((p[0] << 24) >>> 0) + ((p[1] << 16) >>> 0) + ((p[2] << 8) >>> 0) + (p[3] >>> 0);
}

function isPrivateIPv4(host: string) {
    if (!isIPv4(host)) return false;
    const ip = ipv4ToInt(host);
    // 10.0.0.0/8
    if (ip >>> 24 === 10) return true;
    // 172.16.0.0/12 -> 172.16.0.0 - 172.31.255.255
    if (ip >>> 20 === ((172 << 4) + 1)) {
        // above shift trick isn't reliable; do range check instead
    }
    // better explicit ranges
    const start172 = ipv4ToInt('172.16.0.0');
    const end172 = ipv4ToInt('172.31.255.255');
    if (ip >= start172 && ip <= end172) return true;
    // 192.168.0.0/16
    const start192 = ipv4ToInt('192.168.0.0');
    const end192 = ipv4ToInt('192.168.255.255');
    if (ip >= start192 && ip <= end192) return true;
    // 169.254.0.0/16 (link-local)
    const start169 = ipv4ToInt('169.254.0.0');
    const end169 = ipv4ToInt('169.254.255.255');
    if (ip >= start169 && ip <= end169) return true;
    return false;
}

function isLoopbackIPv4(host: string) {
    if (!isIPv4(host)) return false;
    const ip = ipv4ToInt(host);
    const start = ipv4ToInt('127.0.0.0');
    const end = ipv4ToInt('127.255.255.255');
    return ip >= start && ip <= end;
}

function isPrivateIPv6(host: string) {
    // block ::1 and fc00::/7 (addresses starting with fc or fd)
    const h = host.toLowerCase();
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    return false;
}

function isBlockedHost(host: string) {
    if (!host) return true;
    // strip brackets for IPv6 literals like [::1]
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    // hostname checks
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost') || lower === 'ip6-localhost') return true;
    // IP literal checks
    if (isIPv4(host)) {
        if (isLoopbackIPv4(host)) return true;
        if (isPrivateIPv4(host)) return true;
    }
    if (isIPv6(host)) {
        if (isPrivateIPv6(host)) return true;
    }
    return false;
}

async function isHostResolvedToBlockedIP(host: string): Promise<boolean> {
    // If host is an explicit IP literal, we already handle it in isBlockedHost.
    if (isIPv4(host) || isIPv6(host)) return isBlockedHost(host);

    try {
        const dnsMod: any = await import('dns');
        const lookup = dnsMod.promises?.lookup ?? dnsMod.lookup;
        const results: Array<any> = await lookup(host, { all: true });
        for (const r of results) {
            const ip = r.address || r;
            if (!ip) continue;
            if (isIPv4(ip)) {
                if (isLoopbackIPv4(ip) || isPrivateIPv4(ip)) return true;
            } else if (isIPv6(ip)) {
                if (isPrivateIPv6(ip)) return true;
                if (ip === '::1') return true;
            }
        }
        return false;
    } catch (e: any) {
        console.log(`[EXTRACT] DNS lookup failed for ${host}:`, (e as any)?.message ?? e);
        // Fail closed: if we cannot resolve DNS, treat as blocked to avoid SSRF risk
        return true;
    }
}

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

let _pdfParseImpl: any = null;

export function setPdfParseForTests(mockImpl: any) {
    _pdfParseImpl = mockImpl;
}

async function loadPdfParseImpl() {
    if (_pdfParseImpl) return _pdfParseImpl;
    const mod = await import("pdf-parse");
    // pdf-parse may expose different shapes depending on bundler/runtime
    // Handle common forms: default export function, named PDFParse class, or module function
    if (typeof (mod as any).default === "function") return (mod as any).default;
    if (typeof (mod as any) === "function") return mod;
    if ((mod as any).PDFParse) return (mod as any).PDFParse;
    // Fallback to module itself
    return mod;
}

export async function extractPDF(buffer: Buffer): Promise<ExtractionResult> {
    const impl = await loadPdfParseImpl();
    // If PDFParse is a class-like constructor (PDFParse), instantiate and call methods
    if (typeof impl === "function" && impl.prototype && impl.prototype.getText) {
        const parser = new impl({ data: buffer });
        const textResult = await parser.getText();
        const infoResult = await parser.getInfo();
        const text = textResult?.text ?? "";
        return {
            text,
            metadata: {
                content_type: "pdf",
                char_count: text.length,
                estimated_tokens: estimateTokens(text),
                extraction_method: "pdf-parse",
                pages: textResult?.total ?? null,
                info: infoResult ?? null,
            },
        };
    }

    // If impl is a function that directly parses a buffer and returns an object
    if (typeof impl === "function") {
        const result = await impl(buffer);
        const text = result?.text ?? "";
        return {
            text,
            metadata: {
                content_type: "pdf",
                char_count: text.length,
                estimated_tokens: estimateTokens(text),
                extraction_method: "pdf-parse",
                pages: result?.numpages ?? result?.pages ?? null,
                info: result?.info ?? null,
            },
        };
    }

    throw new Error("Unsupported pdf-parse module shape");
}

export async function extractDOCX(buffer: Buffer): Promise<ExtractionResult> {
    const result = await mammoth.extractRawText({ buffer });

    return {
        text: result.value,
        metadata: {
            content_type: "docx",
            char_count: result.value.length,
            estimated_tokens: estimateTokens(result.value),
            extraction_method: "mammoth",
            messages: result.messages,
        },
    };
}

export async function extractHTML(html: string): Promise<ExtractionResult> {
    const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
    });

    const markdown = turndown.turndown(html);

    return {
        text: markdown,
        metadata: {
            content_type: "html",
            char_count: markdown.length,
            estimated_tokens: estimateTokens(markdown),
            extraction_method: "turndown",
            original_html_length: html.length,
        },
    };
}

export async function extractURL(url: string): Promise<ExtractionResult> {
    try {
        // Basic URL validation: only allow http/https
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch (e) {
            console.log(`[EXTRACT] Invalid URL provided: ${url}`);
            throw new Error("Invalid URL");
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            console.log(`[EXTRACT] Unsupported URL protocol: ${parsed.protocol} for ${url}`);
            throw new Error("Unsupported URL protocol");
        }

        // Basic host checks to avoid SSRF to internal addresses. This is a best-effort
        // check that rejects explicit IP literals in private/loopback ranges and
        // common local hostnames. It does NOT perform DNS resolution for hostnames
        // (to avoid introducing extra OS-specific networking dependencies here).
        const host = parsed.hostname;
        if (isBlockedHost(host)) {
            console.log(`[EXTRACT] Blocked host for URL: ${url} (hostname: ${host})`);
            throw new Error("Blocked or private host");
        }

        // Perform DNS resolution to detect hostnames that resolve to private or loopback IPs.
        const resolvesToBlocked = await isHostResolvedToBlockedIP(host);
        if (resolvesToBlocked) {
            console.log(`[EXTRACT] Host resolves to blocked/private IP for URL: ${url} (hostname: ${host})`);
            throw new Error("Blocked or private host (DNS resolution)");
        }

        // Enforce a 30s timeout on fetch to avoid hanging network calls
        const response = await fetch(url, { signal: (globalThis as any).AbortSignal?.timeout?.(30000) });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();

        const turndown = new TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
        });

        const markdown = turndown.turndown(html);

        return {
            text: markdown,
            metadata: {
                content_type: "url",
                char_count: markdown.length,
                estimated_tokens: estimateTokens(markdown),
                extraction_method: "fetch+turndown",
                source_url: url,
                fetched_at: new Date().toISOString(),
            },
        };
    } catch (e: any) {
        console.log(`[EXTRACT] URL extraction failed for ${url}:`, e?.message ?? e);
        throw e;
    }
}

export async function extractText(
    contentType: string,
    data: string | Buffer,
): Promise<ExtractionResult> {
    switch (contentType.toLowerCase()) {
        case "pdf":
            return extractPDF(
                Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data as string, "base64"),
            );

        case "docx":
        case "doc":
            return extractDOCX(
                Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data as string, "base64"),
            );

        case "html":
        case "htm":
            return extractHTML(data.toString());

        case "md":
        case "markdown": {
            const text = data.toString();
            return {
                text,
                metadata: {
                    content_type: "markdown",
                    char_count: text.length,
                    estimated_tokens: estimateTokens(text),
                    extraction_method: "passthrough",
                },
            };
        }

        case "txt":
        case "text": {
            const text = data.toString();
            return {
                text,
                metadata: {
                    content_type: "txt",
                    char_count: text.length,
                    estimated_tokens: estimateTokens(text),
                    extraction_method: "passthrough",
                },
            };
        }

        default:
            throw new Error(`Unsupported content type: ${contentType}`);
    }
}

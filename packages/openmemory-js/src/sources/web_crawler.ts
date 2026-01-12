/**
 * Web Crawler Source Connector for OpenMemory.
 * Provides production-grade crawling with HTML parsing via Cheerio.
 * No authentication required for public URLs.
 */

// We use dynamic import for cheerio, but we can import types
import type { CheerioAPI } from "cheerio";

import { env } from "../core/cfg";
import { logger } from "../utils/logger";
import { validateUrl } from "../utils/security";
import {
    BaseSource,
    SourceConfig,
    SourceConfigError,
    SourceContent,
    SourceFetchError,
    SourceItem,
} from "./base";
import { extractHTML } from "../ops/extract";

export interface WebCrawlerConfig extends SourceConfig {
    maxPages?: number;
    maxDepth?: number;
    timeout?: number;
    delayMs?: number;
}

/**
 * Web Crawler Source Connector.
 * Ingests content from public websites by crawling links up to a specified depth.
 */
export class WebCrawlerSource extends BaseSource {
    override name = "web_crawler";
    private maxPages: number;
    private maxDepth: number;
    private timeout: number;
    private delayMs: number;
    private visited: Set<string> = new Set();
    private crawled: SourceItem[] = [];
    private contentCache: Map<string, { text: string; title: string; metadata: Record<string, unknown> }> = new Map();
    private robotsCache: Map<string, string[]> = new Map(); // domain -> disallowed patterns

    constructor(userId?: string | null, config?: WebCrawlerConfig) {
        super(userId ?? undefined, config);
        this.maxPages = config?.maxPages || 50;
        this.maxDepth = config?.maxDepth || 3;
        this.timeout = config?.timeout || 30000;
        this.delayMs = config?.delayMs ?? env.crawlerDelayMs ?? 1000;
    }

    async _connect(): Promise<boolean> {
        return true; // no auth needed
    }

    async _listItems(filters: {
        startUrl?: string;
        followLinks?: boolean;
    }): Promise<SourceItem[]> {
        if (!filters.startUrl) {
            throw new SourceConfigError("startUrl is required", this.name);
        }

        let cheerioMod: typeof import("cheerio");
        try {
            cheerioMod = await import("cheerio");
        } catch {
            throw new SourceConfigError(
                "missing deps: npm install cheerio",
                this.name,
            );
        }

        this.visited.clear();
        this.crawled = [];
        this.contentCache.clear();

        const baseUrl = new URL(filters.startUrl);
        const baseDomain = baseUrl.hostname;
        const toVisit: { url: string; depth: number }[] = [
            { url: filters.startUrl, depth: 0 },
        ];
        const robotsPatterns = await this._getRobots(baseUrl.origin);
        const followLinks = filters.followLinks !== false;

        while (toVisit.length > 0 && this.crawled.length < this.maxPages) {
            const nextVisit = toVisit.shift();
            if (!nextVisit) break;
            const { url, depth } = nextVisit;

            if (this.visited.has(url) || depth > this.maxDepth) continue;

            // Robots.txt check
            const urlPath = new URL(url).pathname;
            if (robotsPatterns.some(p => urlPath.startsWith(p))) {
                logger.info(`[web_crawler] Skipping ${url} (Disallowed by robots.txt)`);
                continue;
            }

            this.visited.add(url);

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(
                    () => controller.abort(),
                    this.timeout,
                );

                await validateUrl(url);
                const resp = await fetch(url, {
                    headers: {
                        "User-Agent": "OpenMemory-Crawler/1.0 (compatible)",
                    },
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (!resp.ok) continue;

                const contentType = resp.headers.get("content-type") || "";
                const contentLength = resp.headers.get("content-length");

                // Limit to 10MB
                if (
                    contentLength &&
                    parseInt(contentLength, 10) > 10 * 1024 * 1024
                ) {
                    logger.warn(
                        `[web_crawler] Skipping ${url}: Content-Length ${contentLength} exceeds 10MB limit`,
                    );
                    continue;
                }

                if (!contentType.includes("text/html")) continue;

                const MAX_HTML_SIZE = 10 * 1024 * 1024;
                let html = "";

                if (!resp.body) continue;

                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let totalBytes = 0;

                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        totalBytes += value.byteLength;
                        if (totalBytes > MAX_HTML_SIZE) {
                            await reader.cancel();
                            logger.warn(
                                `[web_crawler] Skipping ${url}: Body exceeds 10MB limit (streamed check)`,
                            );
                            html = "";
                            break;
                        }
                        html += decoder.decode(value, { stream: true });
                    }
                    html += decoder.decode(); // final flush
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    logger.error(
                        `[web_crawler] Error reading stream from ${url}:`,
                        { error: msg },
                    );
                    continue;
                }

                if (!html) continue;
                const $: CheerioAPI = cheerioMod.load(html);

                const title = $('meta[property="og:title"]').attr("content") || $("title").text() || url;
                const description = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";
                const canonical = $('link[rel="canonical"]').attr("href") || url;

                const { text, metadata: extMetadata } = await extractHTML(html);

                this.crawled.push({
                    id: url,
                    name: title.trim(),
                    type: "webpage",
                    url,
                    depth,
                    metadata: {
                        ...extMetadata,
                        description: description.trim(),
                        canonical
                    },
                });

                // Cache the content to avoid re-fetching in _fetchItem
                this.contentCache.set(url, {
                    text,
                    title: title.trim(),
                    metadata: { ...extMetadata, description: description.trim(), canonical },
                });

                // find and queue links
                if (followLinks && depth < this.maxDepth) {
                    $("a[href]").each((_idx: number, el: unknown) => {
                        // Element type depends on Cheerio version, treat as generic object for selector
                        const $el = $(el as any);
                        try {
                            const href = $el.attr("href");
                            if (!href) return;

                            const fullUrl = new URL(href, url);
                            if (fullUrl.hostname.toLowerCase() !== baseDomain.toLowerCase()) return;

                            // Protocol safety
                            if (fullUrl.protocol !== "http:" && fullUrl.protocol !== "https:") return;

                            // Canonicalization
                            let cleanUrl = `${fullUrl.protocol}//${fullUrl.hostname.toLowerCase()}${fullUrl.pathname.toLowerCase()}${fullUrl.search}`;
                            if (cleanUrl.endsWith("/") && cleanUrl.length > (fullUrl.protocol.length + fullUrl.hostname.length + 3)) {
                                cleanUrl = cleanUrl.slice(0, -1);
                            }

                            if (!this.visited.has(cleanUrl)) {
                                if (toVisit.length < 500) {
                                    toVisit.push({
                                        url: cleanUrl,
                                        depth: depth + 1,
                                    });
                                } else {
                                    logger.warn(`[web_crawler] Queue full (500), skipping ${cleanUrl}`);
                                }
                            }
                        } catch {
                            // ignore
                        }
                    });
                }

                // Sustainability: Respect rate limit and delay between requests
                await this.rateLimiter.acquire();
                if (this.delayMs > 0 && toVisit.length > 0) {
                    await new Promise((x) => setTimeout(x, this.delayMs));
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.warn(`[web_crawler] Failed to fetch ${url}: ${msg}`);
            }
        }

        return this.crawled;
    }

    async _fetchItem(itemId: string): Promise<SourceContent> {
        // Optimization: Check cache first
        if (this.contentCache.has(itemId)) {
            const cached = this.contentCache.get(itemId)!;
            return {
                id: itemId,
                name: cached.title,
                type: "webpage",
                text: cached.text,
                data: cached.text,
                metadata: {
                    source: "web_crawler",
                    url: itemId,
                    charCount: cached.text.length,
                    cached: true,
                    ...cached.metadata,
                },
            };
        }

        let cheerioMod: typeof import("cheerio");
        try {
            cheerioMod = await import("cheerio");
        } catch {
            throw new SourceConfigError(
                "missing deps: npm install cheerio",
                this.name,
            );
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            await validateUrl(itemId);
            const resp = await fetch(itemId, {
                headers: {
                    "User-Agent": "OpenMemory-Crawler/1.0 (compatible)",
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!resp.ok)
                throw new Error(`http ${resp.status}: ${resp.statusText}`);

            const contentLength = resp.headers.get("content-length");
            if (
                contentLength &&
                parseInt(contentLength, 10) > 10 * 1024 * 1024
            ) {
                throw new Error(
                    `Content-Length ${contentLength} exceeds 10MB limit`,
                );
            }

            const html = await resp.text();
            if (html.length > 10 * 1024 * 1024) {
                throw new Error(
                    `Body length ${html.length} exceeds 10MB limit`,
                );
            }
            const $: CheerioAPI = cheerioMod.load(html);

            const { text, metadata: extMetadata } = await extractHTML(html);

            return {
                id: itemId,
                name: (extMetadata.title as string) || itemId,
                type: "webpage",
                text,
                data: text,
                metadata: {
                    source: "web_crawler",
                    url: itemId,
                    ...extMetadata
                },
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new SourceFetchError(
                msg,
                this.name,
                e instanceof Error ? e : undefined,
            );
        }
    }

    private async _getRobots(origin: string): Promise<string[]> {
        if (this.robotsCache.has(origin)) return this.robotsCache.get(origin)!;

        try {
            const resp = await fetch(`${origin}/robots.txt`, {
                headers: { "User-Agent": "OpenMemory-Crawler/1.0" }
            });
            if (!resp.ok) {
                this.robotsCache.set(origin, []);
                return [];
            }
            const text = await resp.text();
            const lines = text.split("\n");
            const disallowed: string[] = [];
            let isAmTarget = false;

            for (const line of lines) {
                const l = line.trim().toLowerCase();
                if (l.startsWith("user-agent:")) {
                    const ua = l.split(":")[1].trim();
                    isAmTarget = ua === "*" || ua.includes("openmemory") || ua.includes("crawler");
                } else if (isAmTarget && l.startsWith("disallow:")) {
                    const path = l.split(":")[1].trim();
                    if (path) disallowed.push(path);
                }
            }
            this.robotsCache.set(origin, disallowed);
            return disallowed;
        } catch {
            this.robotsCache.set(origin, []);
            return [];
        }
    }
}

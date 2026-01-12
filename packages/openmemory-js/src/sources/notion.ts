/**
 * Notion Source Connector for OpenMemory.
 * Ingests pages and databases from Notion workspaces.
 * Requires: @notionhq/client
 * Environment: NOTION_API_KEY (optional fallback)
 */

import type { Client } from "@notionhq/client";

import { env } from "../core/cfg";
import { logger } from "../utils/logger";
import {
    BaseSource,
    SourceConfigError,
    SourceContent,
    SourceFetchError,
    SourceItem,
} from "./base";

interface NotionPage {
    id: string;
    url: string;
    last_edited_time: string;
    properties: Record<string, unknown>;
}

interface NotionBlock {
    type: string;
    [key: string]: unknown;
}

interface NotionCreds {
    apiKey?: string;
}

interface NotionFilters {
    databaseId?: string;
}

/**
 * Notion Source Connector.
 * Ingests pages and databases from Notion.
 */
export class NotionSource extends BaseSource<NotionCreds, NotionFilters> {
    override name = "notion";
    private client: Client | null = null;

    /**
     * Authenticates with Notion API.
     * Uses `process.env.NOTION_API_KEY` or passed `apiKey`.
     */
    async _connect(creds: NotionCreds): Promise<boolean> {
        let ClientConstructor: typeof Client;
        try {
            ClientConstructor = await import("@notionhq/client").then(
                (m) => m.Client,
            );
        } catch {
            throw new SourceConfigError(
                "missing deps: npm install @notionhq/client",
                this.name,
            );
        }

        // Security: BaseSource.connect has already hydrated creds from Persisted Config
        // Fallback to env.notionApiKey if no apiKey provided at all
        const apiKey = creds.apiKey || env.notionApiKey;

        if (!apiKey) {
            throw new SourceConfigError(
                "Notion API key is required (provide in Dashboard or OM_NOTION_API_KEY)",
                this.name,
            );
        }

        this.client = new ClientConstructor({ auth: apiKey });
        return true;
    }

    private extractTitle(page: NotionPage): string {
        const props = page.properties || {};
        for (const prop of Object.values(props)) {
            const p = prop as {
                type: string;
                title?: { plain_text: string }[];
            };
            if (
                p &&
                typeof p === "object" &&
                p.type === "title" &&
                Array.isArray(p.title) &&
                p.title[0]
            ) {
                return p.title[0].plain_text || "";
            }
        }
        return "";
    }

    /**
     * Lists Pages or Database Entries.
     * If `databaseId` is provided, queries that specific database.
     * Otherwise, searches for all accessible pages (Search API).
     *
     * @param filters - Filter constraints (databaseId).
     */
    async _listItems(filters: NotionFilters): Promise<SourceItem[]> {
        if (!this.client)
            throw new SourceConfigError("not connected", this.name);

        const results: SourceItem[] = [];

        if (filters.databaseId) {
            let hasMore = true;
            let startCursor: string | undefined;

            while (hasMore) {
                const resp = await (this.client.databases as any).query({
                    database_id: filters.databaseId,
                    start_cursor: startCursor,
                });

                for (const page of resp.results) {
                    if ("properties" in page) {
                        const p = page as unknown as NotionPage;
                        results.push({
                            id: page.id,
                            name: this.extractTitle(p) || "Untitled",
                            type: "page",
                            url: p.url || "",
                            lastEdited: p.last_edited_time,
                        });
                    }
                }

                if (results.length >= 1000) {
                    logger.warn(`[notion] Hit hard limit of 1000 items`);
                    break;
                }

                hasMore = resp.has_more;
                startCursor = resp.next_cursor || undefined;
                await this.rateLimiter.acquire();
            }
        } else {
            let hasMore = true;
            let startCursor: string | undefined;

            while (hasMore) {
                const resp = await this.client.search({
                    filter: { property: "object", value: "page" },
                    start_cursor: startCursor,
                });

                for (const page of resp.results) {
                    if ("properties" in page) {
                        const p = page as unknown as NotionPage;
                        results.push({
                            id: page.id,
                            name: this.extractTitle(p) || "Untitled",
                            type: "page",
                            url: p.url || "",
                            lastEdited: p.last_edited_time,
                        });
                    }
                }

                if (results.length >= 1000) {
                    logger.warn(`[notion] Hit hard limit of 1000 items (search)`);
                    break;
                }

                hasMore = resp.has_more;
                startCursor = resp.next_cursor || undefined;
                await this.rateLimiter.acquire();
            }
        }

        return results;
    }

    private blockToText(block: NotionBlock): string {
        const texts: string[] = [];
        const type = block.type;

        const textBlocks = [
            "paragraph",
            "heading_1",
            "heading_2",
            "heading_3",
            "bulleted_list_item",
            "numbered_list_item",
            "quote",
            "callout",
        ];

        if (textBlocks.includes(type)) {
            const content = block[type as keyof NotionBlock] as {
                rich_text?: { plain_text: string }[];
            };
            const richText = content?.rich_text || [];
            for (const rt of richText) {
                texts.push(rt.plain_text || "");
            }
        } else if (type === "code") {
            const content = block.code as {
                rich_text?: { plain_text: string }[];
                language?: string;
            };
            const richText = content?.rich_text || [];
            const lang = content?.language || "";
            const code = richText
                .map((rt: { plain_text: string }) => rt.plain_text || "")
                .join("");
            texts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
        } else if (type === "to_do") {
            const content = block.to_do as {
                checked?: boolean;
                rich_text?: { plain_text: string }[];
            };
            const checked = content?.checked || false;
            const richText = content?.rich_text || [];
            const prefix = checked ? "[x] " : "[ ] ";
            texts.push(
                prefix +
                richText
                    .map(
                        (rt: { plain_text: string }) => rt.plain_text || "",
                    )
                    .join(""),
            );
        }

        return texts.join("");
    }

    /**
     * Fetches a Notion Page and converts its child blocks to Markdown.
     *
     * @param itemId - The UUID of the page.
     */
    async _fetchItem(itemId: string): Promise<SourceContent> {
        if (!this.client)
            throw new SourceConfigError("not connected", this.name);

        let page: unknown;
        try {
            page = await this.client.pages.retrieve({ page_id: itemId });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new SourceFetchError(
                msg,
                this.name,
                e instanceof Error ? e : undefined,
            );
        }

        if (!page || typeof page !== "object" || !("properties" in page)) {
            throw new Error(`Item ${itemId} is not a valid page`);
        }

        const p = page as unknown as NotionPage;
        const title = this.extractTitle(p);
        const url = p.url || "";

        const blocks: NotionBlock[] = [];
        let hasMore = true;
        let startCursor: string | undefined;

        while (hasMore) {
            const resp = await this.client.blocks.children.list({
                block_id: itemId,
                start_cursor: startCursor,
            });
            blocks.push(...(resp.results as unknown as NotionBlock[]));
            hasMore = resp.has_more;
            startCursor = resp.next_cursor || undefined;
            await this.rateLimiter.acquire();
        }

        const textParts = title ? [`# ${title}`] : [];

        for (const block of blocks) {
            const txt = this.blockToText(block);
            if (txt.trim()) textParts.push(txt);
        }

        const text = textParts.join("\n\n");

        return {
            id: itemId,
            name: title || "Untitled",
            type: "notion_page",
            text,
            data: text,
            metadata: {
                source: "notion",
                pageId: itemId,
                url,
                blockCount: blocks.length,
            },
        };
    }
}

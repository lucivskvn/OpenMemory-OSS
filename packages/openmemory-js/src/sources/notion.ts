/**
 * notion source for openmemory - production grade
 * requires: @notionhq/client
 * env vars: NOTION_API_KEY
 */

import { base_source, source_config_error, source_item, source_content } from './base';
import type { Client } from '@notionhq/client';

interface NotionPage {
    id: string;
    url: string;
    last_edited_time: string;
    properties: Record<string, any>;
}

interface NotionBlock {
    type: string;
    [key: string]: any;
}

export class notion_source extends base_source {
    override name = 'notion';
    private client: Client | null = null;

    async _connect(creds: Record<string, any>): Promise<boolean> {
        let ClientConstructor: typeof Client;
        try {
            ClientConstructor = await import('@notionhq/client').then(m => m.Client);
        } catch {
            throw new source_config_error('missing deps: npm install @notionhq/client', this.name);
        }

        const api_key = (creds.api_key as string) || process.env.NOTION_API_KEY;

        if (!api_key) {
            throw new source_config_error('no credentials: set NOTION_API_KEY', this.name);
        }

        this.client = new ClientConstructor({ auth: api_key });
        return true;
    }

    private extract_title(page: NotionPage): string {
        const props = page.properties || {};
        for (const prop of Object.values(props) as any[]) {
            if (prop && typeof prop === 'object' && prop.type === 'title' && Array.isArray(prop.title) && prop.title[0]) {
                return prop.title[0].plain_text || '';
            }
        }
        return '';
    }

    async _list_items(filters: Record<string, any>): Promise<source_item[]> {
        if (!this.client) throw new source_config_error('not connected', this.name);

        const results: source_item[] = [];

        if (filters.database_id) {
            let has_more = true;
            let start_cursor: string | undefined;

            while (has_more) {
                const resp: any = await this.client.databases.query({
                    database_id: filters.database_id as string,
                    start_cursor
                });

                for (const page of resp.results as NotionPage[]) {
                    results.push({
                        id: page.id,
                        name: this.extract_title(page) || 'Untitled',
                        type: 'page',
                        url: page.url || '',
                        last_edited: page.last_edited_time
                    });
                }

                has_more = resp.has_more;
                start_cursor = resp.next_cursor || undefined;
            }
        } else {
            const resp: any = await this.client.search({ filter: { property: 'object', value: 'page' } });

            for (const page of resp.results as NotionPage[]) {
                results.push({
                    id: page.id,
                    name: this.extract_title(page) || 'Untitled',
                    type: 'page',
                    url: page.url || '',
                    last_edited: page.last_edited_time
                });
            }
        }

        return results;
    }

    private block_to_text(block: NotionBlock): string {
        const texts: string[] = [];
        const type = block.type;

        const text_blocks = ['paragraph', 'heading_1', 'heading_2', 'heading_3',
            'bulleted_list_item', 'numbered_list_item', 'quote', 'callout'];

        if (text_blocks.includes(type)) {
            const rich_text = (block[type] as any)?.rich_text || [];
            for (const rt of rich_text) {
                texts.push(rt.plain_text || '');
            }
        } else if (type === 'code') {
            const rich_text = block.code?.rich_text || [];
            const lang = block.code?.language || '';
            const code = rich_text.map((rt: any) => rt.plain_text || '').join('');
            texts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
        } else if (type === 'to_do') {
            const checked = block.to_do?.checked || false;
            const rich_text = block.to_do?.rich_text || [];
            const prefix = checked ? '[x] ' : '[ ] ';
            texts.push(prefix + rich_text.map((rt: any) => rt.plain_text || '').join(''));
        }

        return texts.join('');
    }

    async _fetch_item(item_id: string): Promise<source_content> {
        if (!this.client) throw new source_config_error('not connected', this.name);

        const page: NotionPage = await (this.client.pages.retrieve({ page_id: item_id }) as Promise<any>);
        const title = this.extract_title(page);

        // get all blocks
        const blocks: NotionBlock[] = [];
        let has_more = true;
        let start_cursor: string | undefined;

        while (has_more) {
            const resp: any = await this.client.blocks.children.list({
                block_id: item_id,
                start_cursor
            });
            blocks.push(...(resp.results as NotionBlock[]));
            has_more = resp.has_more;
            start_cursor = resp.next_cursor || undefined;
        }

        const text_parts = title ? [`# ${title}`] : [];

        for (const block of blocks) {
            const txt = this.block_to_text(block);
            if (txt.trim()) text_parts.push(txt);
        }

        const text = text_parts.join('\n\n');

        return {
            id: item_id,
            name: title || 'Untitled',
            type: 'notion_page',
            text,
            data: text,
            meta: { source: 'notion', page_id: item_id, url: page.url || '', block_count: blocks.length }
        };
    }
}

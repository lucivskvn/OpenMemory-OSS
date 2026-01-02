/**
 * google slides source for openmemory - production grade
 * requires: googleapis
 * env vars: GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON
 */

import { base_source, source_config_error, source_item, source_content } from './base';
import type { slides_v1, google as google_type } from 'googleapis';

interface GooglePresentation {
    presentationId: string;
    slides?: slides_v1.Schema$Page[];
    title?: string;
}

export class google_slides_source extends base_source {
    override name = 'google_slides';
    private service: slides_v1.Slides | null = null;
    private auth: any = null;

    async _connect(creds: Record<string, any>): Promise<boolean> {
        let google_mod: typeof google_type;
        try {
            google_mod = await import('googleapis').then(m => m.google);
        } catch {
            throw new source_config_error('missing deps: npm install googleapis', this.name);
        }

        const scopes = ['https://www.googleapis.com/auth/presentations.readonly'];

        if (creds.credentials_json) {
            this.auth = new google_mod.auth.GoogleAuth({ credentials: creds.credentials_json, scopes });
        } else if (creds.service_account_file) {
            this.auth = new google_mod.auth.GoogleAuth({ keyFile: creds.service_account_file as string, scopes });
        } else if (process.env.GOOGLE_CREDENTIALS_JSON) {
            this.auth = new google_mod.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON), scopes });
        } else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
            this.auth = new google_mod.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE, scopes });
        } else {
            throw new source_config_error('no credentials: set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON', this.name);
        }

        this.service = google_mod.slides({ version: 'v1', auth: this.auth });
        return true;
    }

    async _list_items(filters: Record<string, any>): Promise<source_item[]> {
        if (!this.service) throw new source_config_error('not connected', this.name);
        if (!filters.presentation_id) {
            throw new source_config_error('presentation_id is required', this.name);
        }

        try {
            const pres = await this.service.presentations.get({ presentationId: filters.presentation_id as string });
            const data = pres.data as GooglePresentation;

            return (data.slides || []).map((slide, i: number) => ({
                id: `${filters.presentation_id}#${slide.objectId}`,
                name: `Slide ${i + 1}`,
                type: 'slide',
                index: i,
                presentation_id: filters.presentation_id as string,
                object_id: slide.objectId!
            }));
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`[google_slides] list failed: ${msg}`);
        }
    }

    async _fetch_item(item_id: string): Promise<source_content> {
        if (!this.service) throw new source_config_error('not connected', this.name);

        const [presentation_id, slide_id] = item_id.includes('#')
            ? item_id.split('#', 2)
            : [item_id, null];

        try {
            const pres = await this.service.presentations.get({ presentationId: presentation_id });
            const data = pres.data as GooglePresentation;

            const extract_text = (element: slides_v1.Schema$PageElement): string => {
                const texts: string[] = [];

                if (element.shape?.text) {
                    for (const te of element.shape.text.textElements || []) {
                        if (te.textRun) texts.push(te.textRun.content || '');
                    }
                }

                if (element.table) {
                    for (const row of element.table.tableRows || []) {
                        for (const cell of row.tableCells || []) {
                            if (cell.text) {
                                for (const te of cell.text.textElements || []) {
                                    if (te.textRun) texts.push(te.textRun.content || '');
                                }
                            }
                        }
                    }
                }

                return texts.join('');
            };

            const all_text: string[] = [];

            for (let i = 0; i < (data.slides || []).length; i++) {
                const slide = (data.slides || [])[i];
                if (slide_id && slide.objectId !== slide_id) continue;

                const slide_texts = [`## Slide ${i + 1}`];

                for (const element of slide.pageElements || []) {
                    const txt = extract_text(element);
                    if (txt.trim()) slide_texts.push(txt.trim());
                }

                all_text.push(...slide_texts);
            }

            const text = all_text.join('\n\n');

            return {
                id: item_id,
                name: data.title || 'Untitled Presentation',
                type: 'presentation',
                text,
                data: text,
                meta: { source: 'google_slides', presentation_id, slide_count: data.slides?.length || 0 }
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`[google_slides] fetch failed: ${msg}`);
        }
    }
}

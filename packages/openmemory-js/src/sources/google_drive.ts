/**
 * google drive source for openmemory - production grade
 * requires: googleapis
 * env vars: GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON
 */

import { base_source, source_config_error, source_item, source_content } from './base';
import type { drive_v3, google as google_type } from 'googleapis';

export class google_drive_source extends base_source {
    override name = 'google_drive';
    private service: drive_v3.Drive | null = null;
    private auth: any = null;

    async _connect(creds: Record<string, any>): Promise<boolean> {
        let google_mod: typeof google_type;
        try {
            google_mod = await import('googleapis').then(m => m.google);
        } catch {
            throw new source_config_error('missing deps: npm install googleapis', this.name);
        }

        const scopes = ['https://www.googleapis.com/auth/drive.readonly'];

        if (creds.credentials_json) {
            this.auth = new google_mod.auth.GoogleAuth({
                credentials: creds.credentials_json,
                scopes
            });
        } else if (creds.service_account_file) {
            this.auth = new google_mod.auth.GoogleAuth({
                keyFile: creds.service_account_file as string,
                scopes
            });
        } else if (process.env.GOOGLE_CREDENTIALS_JSON) {
            this.auth = new google_mod.auth.GoogleAuth({
                credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
                scopes
            });
        } else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
            this.auth = new google_mod.auth.GoogleAuth({
                keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
                scopes
            });
        } else {
            throw new source_config_error(
                'no credentials: set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON',
                this.name
            );
        }

        this.service = google_mod.drive({ version: 'v3', auth: this.auth });
        return true;
    }

    async _list_items(filters: Record<string, any>): Promise<source_item[]> {
        if (!this.service) throw new source_config_error('not connected', this.name);

        const q_parts = ['trashed=false'];

        if (filters.folder_id) {
            q_parts.push(`'${filters.folder_id}' in parents`);
        }

        if (filters.mime_types?.length) {
            const mime_q = (filters.mime_types as string[]).map((m: string) => `mimeType='${m}'`).join(' or ');
            q_parts.push(`(${mime_q})`);
        }

        const query = q_parts.join(' and ');
        const results: source_item[] = [];
        let page_token: string | undefined;

        try {
            do {
                const resp: any = await this.service.files.list({
                    q: query,
                    spaces: 'drive',
                    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
                    pageToken: page_token,
                    pageSize: 100
                });

                for (const f of resp.data.files || []) {
                    results.push({
                        id: f.id!,
                        name: f.name!,
                        type: f.mimeType!,
                        modified: f.modifiedTime,
                        size: typeof f.size === 'string' ? parseInt(f.size) : f.size
                    });
                }

                page_token = resp.data.nextPageToken || undefined;
            } while (page_token);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[google_drive] list failed: ${msg}`);
        }

        return results;
    }

    async _fetch_item(item_id: string): Promise<source_content> {
        if (!this.service) throw new source_config_error('not connected', this.name);

        const meta = await this.service.files.get({
            fileId: item_id,
            fields: 'id,name,mimeType'
        });

        const mime = meta.data.mimeType;
        let text = '';
        let data: string | Buffer = '';

        try {
            // google docs -> export as text
            if (mime === 'application/vnd.google-apps.document') {
                const resp = await this.service.files.export({ fileId: item_id, mimeType: 'text/plain' });
                text = resp.data as string;
                data = text;
            }
            // google sheets -> export as csv
            else if (mime === 'application/vnd.google-apps.spreadsheet') {
                const resp = await this.service.files.export({ fileId: item_id, mimeType: 'text/csv' });
                text = resp.data as string;
                data = text;
            }
            // google slides -> export as plain text
            else if (mime === 'application/vnd.google-apps.presentation') {
                const resp = await this.service.files.export({ fileId: item_id, mimeType: 'text/plain' });
                text = resp.data as string;
                data = text;
            }
            // other files -> download raw
            else {
                const resp = await this.service.files.get({ fileId: item_id, alt: 'media' }, { responseType: 'arraybuffer' });
                data = Buffer.from(resp.data as ArrayBuffer);
                try {
                    text = data.toString('utf-8');
                } catch {
                    text = '';
                }
            }

            return {
                id: item_id,
                name: meta.data.name!,
                type: mime!,
                text,
                data,
                meta: { source: 'google_drive', file_id: item_id, mime_type: mime }
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`[google_drive] fetch failed: ${msg}`);
        }
    }
}

/**
 * google sheets source for openmemory - production grade
 * requires: googleapis
 * env vars: GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON
 */

import { base_source, source_config_error, source_item, source_content } from './base';
import type { sheets_v4, google as google_type } from 'googleapis';

export class google_sheets_source extends base_source {
    override name = 'google_sheets';
    private service: sheets_v4.Sheets | null = null;
    private auth: any = null;

    async _connect(creds: Record<string, any>): Promise<boolean> {
        let google_mod: typeof google_type;
        try {
            google_mod = await import('googleapis').then(m => m.google);
        } catch {
            throw new source_config_error('missing deps: npm install googleapis', this.name);
        }

        const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

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

        this.service = google_mod.sheets({ version: 'v4', auth: this.auth });
        return true;
    }

    async _list_items(filters: Record<string, any>): Promise<source_item[]> {
        if (!this.service) throw new source_config_error('not connected', this.name);
        if (!filters.spreadsheet_id) {
            throw new source_config_error('spreadsheet_id is required', this.name);
        }

        try {
            const meta = await this.service.spreadsheets.get({ spreadsheetId: filters.spreadsheet_id as string });

            return (meta.data.sheets || []).map((sheet: any, i: number) => ({
                id: `${filters.spreadsheet_id}!${sheet.properties?.title || 'Sheet1'}`,
                name: sheet.properties?.title || 'Sheet1',
                type: 'sheet',
                index: i,
                spreadsheet_id: filters.spreadsheet_id as string
            }));
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`[google_sheets] list failed: ${msg}`);
        }
    }

    async _fetch_item(item_id: string): Promise<source_content> {
        if (!this.service) throw new source_config_error('not connected', this.name);

        const [spreadsheet_id, sheet_range] = item_id.includes('!')
            ? item_id.split('!', 2)
            : [item_id, 'A:ZZ'];

        try {
            const result = await this.service.spreadsheets.values.get({
                spreadsheetId: spreadsheet_id,
                range: sheet_range
            });

            const values = result.data.values || [];

            // convert to markdown table
            const lines = values.map((row: any[], i: number) => {
                const line = row.map(String).join(' | ');
                return i === 0 ? `${line}\n${row.map(() => '---').join(' | ')}` : line;
            });

            const text = lines.join('\n');

            return {
                id: item_id,
                name: sheet_range,
                type: 'spreadsheet',
                text,
                data: text,
                meta: { source: 'google_sheets', spreadsheet_id, range: sheet_range, row_count: values.length }
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`[google_sheets] fetch failed: ${msg}`);
        }
    }
}

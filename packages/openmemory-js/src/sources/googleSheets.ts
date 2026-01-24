/**
 * Google Sheets Source Connector for OpenMemory.
 * Ingests data from Google Sheets and converts to Markdown tables.
 * Requires: googleapis
 * Environment: GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON
 */

import type { google, sheets_v4 } from "googleapis";

import { env } from "../core/cfg";
import {
    BaseSource,
    SourceConfigError,
    SourceContent,
    SourceFetchError,
    SourceItem,
} from "./base";

interface GoogleSheetsCreds {
    credentialsJson?: Record<string, unknown>;
    serviceAccountFile?: string;
}

interface GoogleSheetsFilters {
    spreadsheetId?: string;
    [key: string]: unknown;
}

/**
 * Google Sheets Source Connector.
 * Ingests spreadsheets from Google Sheets.
 */
export class GoogleSheetsSource extends BaseSource<
    GoogleSheetsCreds,
    GoogleSheetsFilters
> {
    override name = "google_sheets";
    private service: sheets_v4.Sheets | null = null;
    private auth: unknown = null;

    async _connect(creds: GoogleSheetsCreds): Promise<boolean> {
        let googleMod: typeof google;
        try {
            googleMod = await import("googleapis").then((m) => m.google);
        } catch {
            throw new SourceConfigError(
                "missing deps: npm install googleapis",
                this.name,
            );
        }

        const scopes = [
            "https://www.googleapis.com/auth/spreadsheets.readonly",
        ];

        // Security: BaseSource.connect has already hydrated creds from Persisted Config
        // Fallback to env ONLY if no credentials provided at all
        const credentialsJson = creds.credentialsJson || (env.googleCredentialsJson ? JSON.parse(env.googleCredentialsJson) : undefined);
        const serviceAccountFile = creds.serviceAccountFile || env.googleServiceAccountFile;

        if (credentialsJson) {
            this.auth = new googleMod.auth.GoogleAuth({
                credentials: credentialsJson,
                scopes,
            });
        } else if (serviceAccountFile) {
            this.auth = new googleMod.auth.GoogleAuth({
                keyFile: serviceAccountFile,
                scopes,
            });
        } else {
            throw new SourceConfigError(
                "Google Sheets credentials are required (provide in Dashboard or OM_GOOGLE_...)",
                this.name,
            );
        }

        this.service = googleMod.sheets({
            version: "v4",
            auth: this.auth as never, // type-safe cast for dynamically imported auth
        });
        return true;
    }

    /**
     * Lists sheets within a specific Spreadsheet.
     * @param filters - Must contain `spreadsheetId`.
     */
    async _listItems(filters: GoogleSheetsFilters): Promise<SourceItem[]> {
        if (!this.service)
            throw new SourceConfigError("not connected", this.name);
        if (!filters.spreadsheetId) {
            throw new SourceConfigError("spreadsheetId is required", this.name);
        }

        try {
            const meta = await this.service.spreadsheets.get({
                spreadsheetId: filters.spreadsheetId,
            });
            const sheets = meta.data.sheets || [];

            return sheets.map((sheet, i) => ({
                id: `${filters.spreadsheetId}!${sheet.properties?.title || "Sheet1"}`,
                name: sheet.properties?.title || "Sheet1",
                type: "sheet",
                index: i,
                spreadsheetId: filters.spreadsheetId as string,
            }));
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`[google_sheets] list failed: ${msg}`);
        }
    }

    /**
     * Fetches the content of a specific sheet or range.
     * Converts the 2D grid value response into a Markdown table string.
     *
     * @param itemId - Format: `spreadsheetId` (all) or `spreadsheetId!SheetName`.
     */
    async _fetchItem(itemId: string): Promise<SourceContent> {
        if (!this.service)
            throw new SourceConfigError("not connected", this.name);

        const [spreadsheetId, sheetRange] = itemId.includes("!")
            ? itemId.split("!", 2)
            : [itemId, "A:ZZ"];

        try {
            const result = await this.service.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: sheetRange,
            });

            const values = result.data.values || [];

            // convert to markdown table with escaping and alignment
            const escapeTable = (s: string) => (s || "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");

            const lines = values.map((row: unknown[], i: number) => {
                const line = "| " + row.map((c) => escapeTable(String(c))).join(" | ") + " |";
                if (i === 0) {
                    const separator = "| " + row.map(() => "---").join(" | ") + " |";
                    return `${line}\n${separator}`;
                }
                return line;
            });

            const text = lines.join("\n");

            return {
                id: itemId,
                name: sheetRange,
                type: "spreadsheet",
                text,
                data: text,
                metadata: {
                    source: "google_sheets",
                    spreadsheetId,
                    range: sheetRange,
                    rowCount: values.length,
                },
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new SourceFetchError(msg, this.name, e instanceof Error ? e : undefined);
        }
    }
}

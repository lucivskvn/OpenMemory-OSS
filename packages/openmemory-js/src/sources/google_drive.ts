/**
 * Google Drive Source Connector for OpenMemory.
 * Ingests files and Google Workspace documents with automated export conversion.
 * Requires: googleapis
 * Environment: GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON
 */

import type { drive_v3, google } from "googleapis";

import { env } from "../core/cfg";
import { logger } from "../utils/logger";
import {
    BaseSource,
    SourceConfigError,
    SourceContent,
    SourceFetchError,
    SourceItem,
} from "./base";

interface GoogleDriveCreds {
    credentialsJson?: Record<string, unknown>;
    serviceAccountFile?: string;
}

interface GoogleDriveFilters {
    folderId?: string;
    mimeTypes?: string[];
}

/**
 * Google Drive Source Connector.
 * Ingests files and Google Workspace documents (Docs, Sheets, Slides).
 * Features: Automatic export conversion (to Text/CSV), Folder recursion, and Rate Limiting.
 */
export class GoogleDriveSource extends BaseSource<
    GoogleDriveCreds,
    GoogleDriveFilters
> {
    override name = "google_drive";
    private service: drive_v3.Drive | null = null;
    private auth: unknown = null; // Typing GoogleAuth dynamically is complex, but any cast is minimized

    /**
     * Authenticates with Google Drive API.
     * Supports Service Account (server-to-server) and User Auth (via Credentials JSON).
     */
    async _connect(creds: GoogleDriveCreds): Promise<boolean> {
        let googleMod: typeof google;
        try {
            googleMod = await import("googleapis").then((m) => m.google);
        } catch {
            throw new SourceConfigError(
                "missing deps: npm install googleapis",
                this.name,
            );
        }

        const scopes = ["https://www.googleapis.com/auth/drive.readonly"];

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
                "Google Drive credentials are required (provide in Dashboard or OM_GOOGLE_...)",
                this.name,
            );
        }

        this.service = googleMod.drive({
            version: "v3",
            auth: this.auth as never, // type-safe cast for dynamically imported auth
        });
        return true;
    }

    /**
     * Lists files from Google Drive based on filters.
     * Supports folder recursion (via 'in parents' query) and mimeType filtering.
     *
     * @param filters - Filter options (folderId, mimeTypes).
     */
    async _listItems(filters: GoogleDriveFilters): Promise<SourceItem[]> {
        if (!this.service)
            throw new SourceConfigError("not connected", this.name);

        const queryParts = ["trashed=false"];

        if (filters.folderId) {
            queryParts.push(`'${filters.folderId}' in parents`);
        }

        if (filters.mimeTypes?.length) {
            const mimeQuery = (filters.mimeTypes as string[])
                .map((m: string) => `mimeType='${m}'`)
                .join(" or ");
            queryParts.push(`(${mimeQuery})`);
        }

        const query = queryParts.join(" and ");
        const results: SourceItem[] = [];
        let pageToken: string | undefined;

        try {
            do {
                const resp = await this.service.files.list({
                    q: query,
                    spaces: "drive",
                    fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)",
                    pageToken: pageToken,
                    pageSize: 100,
                });

                if (resp.data.files) {
                    for (const f of resp.data.files) {
                        results.push({
                            id: f.id!,
                            name: f.name!,
                            type: f.mimeType!,
                            modified: f.modifiedTime,
                            size:
                                typeof f.size === "string"
                                    ? parseInt(f.size)
                                    : f.size || 0,
                        });
                    }
                }

                if (results.length >= 1000) {
                    logger.warn(`[google_drive] Hit hard limit of 1000 items`);
                    break;
                }
                pageToken = resp.data.nextPageToken || undefined;
                await this.rateLimiter.acquire();
            } while (pageToken);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn(`[google_drive] List failed: ${msg}`);
        }

        return results;
    }

    /**
     * Fetches file content from Drive.
     * Handles automatic export for Google Docs/Sheets/Slides to text/csv.
     *
     * @param itemId - The File ID.
     */
    async _fetchItem(itemId: string): Promise<SourceContent> {
        if (!this.service)
            throw new SourceConfigError("not connected", this.name);

        const fileMeta = await this.service.files.get({
            fileId: itemId,
            fields: "id,name,mimeType,size",
        });

        const sizeStr = (fileMeta.data as drive_v3.Schema$File).size;
        const size = sizeStr ? parseInt(sizeStr, 10) : 0;
        if (size > 10 * 1024 * 1024) {
            throw new SourceFetchError(
                `File too large: ${size} bytes (max 10MB)`,
                this.name,
            );
        }

        const mime = fileMeta.data.mimeType;
        let text = "";
        let data: string | Buffer = "";

        try {
            // google docs -> export as text
            if (mime === "application/vnd.google-apps.document") {
                const resp = await this.service.files.export({
                    fileId: itemId,
                    mimeType: "text/plain",
                });
                text = resp.data as string;
                data = text;
            }
            // google sheets -> export as csv
            else if (mime === "application/vnd.google-apps.spreadsheet") {
                const resp = await this.service.files.export({
                    fileId: itemId,
                    mimeType: "text/csv",
                });
                text = resp.data as string;
                data = text;
            }
            // google slides -> export as plain text
            else if (mime === "application/vnd.google-apps.presentation") {
                const resp = await this.service.files.export({
                    fileId: itemId,
                    mimeType: "text/plain",
                });
                text = (resp.data as string) || "";
                if (!text.trim()) {
                    logger.warn(`[google_drive] Exported presentation ${itemId} is empty, skipping.`);
                    throw new SourceFetchError("Exported content is empty", this.name);
                }
                data = text;
            }
            // other files -> download raw
            else {
                const resp = await this.service.files.get(
                    { fileId: itemId, alt: "media" },
                    { responseType: "arraybuffer" },
                );
                data = Buffer.from(resp.data as ArrayBuffer);
                try {
                    text = data.toString("utf-8");
                } catch {
                    text = "";
                }
            }

            return {
                id: itemId,
                name: fileMeta.data.name!,
                type: mime!,
                text,
                data,
                metadata: {
                    source: "google_drive",
                    fileId: itemId,
                    mimeType: mime,
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
}

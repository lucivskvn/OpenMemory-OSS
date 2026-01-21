/**
 * OneDrive Source Connector for OpenMemory.
 * Ingests files from Microsoft OneDrive using the Graph API.
 * Requires: @azure/msal-node
 * Environment: AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID
 */

import type * as msalType from "@azure/msal-node";

import { env } from "../core/cfg";
import { logger } from "../utils/logger";
import {
    BaseSource,
    SourceAuthError,
    SourceConfigError,
    SourceContent,
    SourceFetchError,
    SourceItem,
} from "./base";

export interface OneDriveCreds {
    clientId?: string;
    clientSecret?: string;
    tenantId?: string;
    accessToken?: string;
}

export interface OneDriveFilters {
    folderPath?: string;
    userPrincipal?: string;
}

/**
 * OneDrive Source Connector.
 * Ingests files from Microsoft OneDrive using the Graph API.
 * Features: App-only authentication, Folder traversal, and Rate Limiting.
 */
export class OneDriveSource extends BaseSource<OneDriveCreds, OneDriveFilters> {
    override name = "onedrive";
    private accessToken: string | null = null;
    private graphUrl = "https://graph.microsoft.com/v1.0";

    /**
     * Authenticates with Microsoft Graph API using Client Credentials flow (App-only).
     * Uses `azure-msal-node`.
     */
    async _connect(creds: OneDriveCreds): Promise<boolean> {
        if (creds.accessToken) {
            this.accessToken = creds.accessToken;
            return true;
        }

        let msalMod: typeof msalType;
        try {
            msalMod = await import("@azure/msal-node");
        } catch {
            throw new SourceConfigError(
                "missing deps: npm install @azure/msal-node",
                this.name,
            );
        }

        // Security: BaseSource.connect has already hydrated creds from Persisted Config
        // Fallback to env ONLY if no credentials provided at all
        const cId = creds.clientId || env.azureClientId;
        const cSec = creds.clientSecret || env.azureClientSecret;
        const tId = creds.tenantId || env.azureTenantId;

        if (!cId || !cSec || !tId) {
            throw new SourceConfigError(
                "Azure credentials are required (provide in Dashboard or AZURE_...)",
                this.name,
            );
        }

        const app = new msalMod.ConfidentialClientApplication({
            auth: {
                clientId: cId as string,
                clientSecret: cSec as string,
                authority: `https://login.microsoftonline.com/${tId}`,
            },
        });

        const result = await app.acquireTokenByClientCredential({
            scopes: ["https://graph.microsoft.com/.default"],
        });

        if (result?.accessToken) {
            this.accessToken = result.accessToken;
            return true;
        }

        throw new SourceAuthError(
            "auth failed: no access token returned",
            this.name,
        );
    }

    /**
     * Lists files from OneDrive.
     * Supports recursive folder traversal (manual recursion upstream? no, iterative via nextLink).
     *
     * @param filters - Options: `folderPath` (starts at root if empty), `userPrincipal` (for admin multi-user access).
     */
    async _listItems(filters: OneDriveFilters): Promise<SourceItem[]> {
        if (!this.accessToken)
            throw new SourceConfigError("not connected", this.name);

        const folderPath = (filters.folderPath as string) || "/";
        const userPrincipal = filters.userPrincipal as string | undefined;

        const base = userPrincipal
            ? `${this.graphUrl}/users/${userPrincipal}/drive`
            : `${this.graphUrl}/me/drive`;

        // Queue for recursion: [api_url, logical_path]
        const initialUrl =
            folderPath === "/"
                ? `${base}/root/children`
                : `${base}/root:/${folderPath.replace(/^\/|\/$/g, "")}:/children`;

        const queue: string[] = [initialUrl];
        const results: SourceItem[] = [];
        const processedUrls = new Set<string>();

        try {
            while (queue.length > 0) {
                const currentUrl = queue.shift()!;
                if (processedUrls.has(currentUrl)) continue;
                processedUrls.add(currentUrl);

                let nextLink: string | null = currentUrl;

                while (nextLink) {
                    const resp: Response = await fetch(nextLink, {
                        headers: { Authorization: `Bearer ${this.accessToken}` },
                    });

                    if (!resp.ok) {
                        logger.warn(`[onedrive] Failed to list ${nextLink}: ${resp.status}`);
                        break;
                    }

                    const data = (await resp.json()) as {
                        value?: Record<string, unknown>[];
                        "@odata.nextLink"?: string;
                    };

                    for (const item of data.value || []) {
                        const driveId = (item.parentReference as { driveId?: string })?.driveId;
                        const isFolder = "folder" in item;

                        results.push({
                            id: driveId ? `${driveId}:${item.id}` : String(item.id),
                            name: String(item.name || "untitled"),
                            type: isFolder
                                ? "folder"
                                : (item.file as { mimeType?: string })?.mimeType || "file",
                            size: Number(item.size || 0),
                            modified: String(item.lastModifiedDateTime || ""),
                            path: (item.parentReference as { path?: string })?.path || "",
                            userPrincipal,
                        });

                        // Add folder children to queue
                        if (isFolder && item.id) {
                            queue.push(`${base}/items/${item.id}/children`);
                        }
                    }

                    nextLink = (data["@odata.nextLink"] as string) || null;
                    if (nextLink) await this.rateLimiter.acquire();

                    if (results.length >= 2000) { // Higher limit for recursive drives
                        logger.warn(`[onedrive] Hit hard limit of 2000 items`);
                        return results;
                    }
                }
                await this.rateLimiter.acquire();
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn(`[onedrive] List failed: ${msg}`);
        }

        return results;
    }

    /**
     * Fetches file content using Graph API `/content` endpoint.
     *
     * @param itemId - Drive Item ID.
     */
    async _fetchItem(itemId: string): Promise<SourceContent> {
        if (!this.accessToken)
            throw new SourceConfigError("not connected", this.name);

        const [driveId, actualId] = itemId.includes(":") ? itemId.split(":") : [null, itemId];

        const base = driveId
            ? `${this.graphUrl}/drives/${driveId}`
            : `${this.graphUrl}/me/drive`;

        try {
            const metaResponse = await fetch(`${base}/items/${actualId}`, {
                headers: { Authorization: `Bearer ${this.accessToken}` },
            });

            if (!metaResponse.ok)
                throw new Error(`http ${metaResponse.status}`);
            const itemMeta = (await metaResponse.json()) as {
                name?: string;
                file?: { mimeType: string };
                size?: number;
            };

            const size = itemMeta.size || 0;
            if (size > 10 * 1024 * 1024) {
                throw new SourceFetchError(
                    `File too large: ${size} bytes (max 10MB)`,
                    this.name,
                );
            }

            const contentResponse = await fetch(
                `${base}/items/${actualId}/content`,
                {
                    headers: { Authorization: `Bearer ${this.accessToken}` },
                    redirect: "follow",
                },
            );

            if (!contentResponse.ok)
                throw new Error(`http ${contentResponse.status}`);
            const data = Buffer.from(await contentResponse.arrayBuffer());

            let text = "";
            try {
                text = data.toString("utf-8");
            } catch {
                // ignore
            }

            return {
                id: itemId,
                name: itemMeta.name || "unknown",
                type: itemMeta.file?.mimeType || "unknown",
                text,
                data,
                metadata: {
                    source: "onedrive",
                    driveId,
                    itemId: actualId,
                    size: itemMeta.size || 0,
                    mimeType: itemMeta.file?.mimeType || "",
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

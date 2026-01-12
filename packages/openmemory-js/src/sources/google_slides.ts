/**
 * Google Slides Source Connector for OpenMemory.
 * Ingests text content from Google Slides presentations.
 * Requires: googleapis
 * Environment: GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_CREDENTIALS_JSON
 */

import type { google, slides_v1 } from "googleapis";

import { env } from "../core/cfg";
import {
    BaseSource,
    SourceConfigError,
    SourceContent,
    SourceFetchError,
    SourceItem,
} from "./base";

interface GoogleSlidesCreds {
    credentialsJson?: Record<string, unknown>;
    serviceAccountFile?: string;
}

interface GoogleSlidesFilters {
    presentationId?: string;
    [key: string]: unknown;
}

/**
 * Google Slides Source Connector.
 * Ingests presentations from Google Slides.
 */
export class GoogleSlidesSource extends BaseSource<
    GoogleSlidesCreds,
    GoogleSlidesFilters
> {
    override name = "google_slides";
    private service: slides_v1.Slides | null = null;
    private auth: unknown = null;

    async _connect(creds: GoogleSlidesCreds): Promise<boolean> {
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
            "https://www.googleapis.com/auth/presentations.readonly",
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
                "Google Slides credentials are required (provide in Dashboard or OM_GOOGLE_...)",
                this.name,
            );
        }

        this.service = googleMod.slides({
            version: "v1",
            auth: this.auth as never, // type-safe cast for dynamically imported auth
        });
        return true;
    }

    async _listItems(filters: GoogleSlidesFilters): Promise<SourceItem[]> {
        if (!this.service)
            throw new SourceConfigError("not connected", this.name);
        if (!filters.presentationId) {
            throw new SourceConfigError(
                "presentationId is required",
                this.name,
            );
        }

        try {
            const pres = await this.service.presentations.get({
                presentationId: filters.presentationId,
            });
            const data = pres.data as slides_v1.Schema$Presentation;

            return (data.slides || []).map((slide, i: number) => ({
                id: `${filters.presentationId}#${slide.objectId}`,
                name: `Slide ${i + 1}`,
                type: "slide",
                index: i,
                presentationId: filters.presentationId as string,
                objectId: slide.objectId!,
            }));
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`[google_slides] list failed: ${msg}`);
        }
    }

    async _fetchItem(itemId: string): Promise<SourceContent> {
        if (!this.service)
            throw new SourceConfigError("not connected", this.name);

        const [presentationId, slideId] = itemId.includes("#")
            ? itemId.split("#", 2)
            : [itemId, null];

        try {
            const pres = await this.service.presentations.get({
                presentationId: presentationId,
            });
            const data = pres.data as slides_v1.Schema$Presentation;

            const extractText = (
                element: slides_v1.Schema$PageElement,
            ): string => {
                const texts: string[] = [];

                if (element.shape?.text) {
                    for (const te of element.shape.text.textElements || []) {
                        if (te.textRun) texts.push(te.textRun.content || "");
                    }
                }

                if (element.table) {
                    for (const row of element.table.tableRows || []) {
                        for (const cell of row.tableCells || []) {
                            if (cell.text) {
                                for (const te of cell.text.textElements || []) {
                                    if (te.textRun)
                                        texts.push(te.textRun.content || "");
                                }
                            }
                        }
                    }
                }

                return texts.join("");
            };

            const allText: string[] = [];

            for (let i = 0; i < (data.slides || []).length; i++) {
                const slide = (data.slides || [])[i];
                if (slideId && slide.objectId !== slideId) continue;

                const slideTexts = [`## Slide ${i + 1}`];

                for (const element of slide.pageElements || []) {
                    const txt = extractText(element);
                    if (txt.trim()) slideTexts.push(txt.trim());
                }

                // Extract Speaker Notes
                const notesPage = slide.slideProperties?.notesPage;
                if (notesPage) {
                    const notesTexts: string[] = [];
                    for (const element of notesPage.pageElements || []) {
                        const txt = extractText(element);
                        if (txt.trim()) notesTexts.push(txt.trim());
                    }
                    if (notesTexts.length > 0) {
                        slideTexts.push("**Speaker Notes:**\n" + notesTexts.join("\n"));
                    }
                }

                allText.push(...slideTexts);
            }

            const text = allText.join("\n\n");

            return {
                id: itemId,
                name: data.title || "Untitled Presentation",
                type: "presentation",
                text,
                data: text,
                metadata: {
                    source: "google_slides",
                    presentationId,
                    slideCount: data.slides?.length || 0,
                },
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new SourceFetchError(msg, this.name, e instanceof Error ? e : undefined);
        }
    }
}

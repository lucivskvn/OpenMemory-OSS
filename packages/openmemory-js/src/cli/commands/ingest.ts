
import { CliFlags } from "../types";
import { ensureClient } from "../utils";

export const ingestCommands = {
    "ingest-url": async (args: string[], flags: CliFlags) => {
        if (!args[0]) throw new Error("URL required");
        const api = await ensureClient(flags);
        const res = await api.ingestUrl(args[0], { userId: flags.userId });
        console.log(JSON.stringify(res, null, 2));
    },

    ingest: async (args: string[], flags: CliFlags) => {
        if (!args[0]) throw new Error("Source name required");
        const srcName = args[0];
        const api = await ensureClient(flags);
        const src = await api.source(srcName);

        if (!flags.host) {
            // Local Interactive
            if (src.connect && typeof src.connect === 'function') {
                await src.connect();
            }
            console.log("Starting local ingestion...");
            const stats = await src.ingestAll({});
            console.log("Ingestion complete:", stats);
        } else {
            // Remote Trigger
            console.log(`Triggering remote ingestion for ${srcName}...`);
            const res = await src.ingestAll({});
            console.log("Remote result:", res);
        }
    },

    "ingest-av": async (args: string[], flags: CliFlags) => {
        const filePath = args[0];
        if (!filePath) throw new Error("File path required");

        const fs = await import("fs/promises");
        const path = await import("path");
        const buffer = await fs.readFile(filePath);

        const ext = path.extname(filePath).toLowerCase();
        const mimeMap: Record<string, string> = {
            ".wav": "audio/wav",
            ".mp3": "audio/mp3",
            ".webm": "video/webm",
            ".mp4": "video/mp4",
            ".pdf": "application/pdf",
            ".md": "text/markdown",
            ".txt": "text/plain",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        };

        const contentType = mimeMap[ext] || "application/octet-stream";
        if (contentType === "application/octet-stream") {
            console.warn(`\x1b[33mWarning: Unknown extension ${ext}, defaulting to application/octet-stream\x1b[0m`);
        }

        console.error(`Ingesting ${filePath} (${contentType})...`); // Use stderr for status
        const api = await ensureClient(flags);
        const ingestRes = await api.ingest(contentType, buffer, {
            metadata: { sourceFile: filePath, ingestType: "av-cli" },
            userId: flags.userId || null
        });
        console.log(JSON.stringify(ingestRes, null, 2));
    }
};


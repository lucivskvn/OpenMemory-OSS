import logger from "../core/logger";

export async function getNormalizedFileSize(f: any): Promise<number | null> {
    try {
        const maybeSize: any = (f as any).size;
        if (typeof maybeSize === "number") return maybeSize;
        if (maybeSize && typeof maybeSize.then === "function") {
            try {
                const v = await maybeSize;
                return typeof v === "number" ? v : null;
            } catch (_e) {
                return null;
            }
        }
        return null;
    } catch (_e) {
        return null;
    }
}

export function logFileProcessing(component: string, filePath: string, fileSize: number | null, mimeType?: string, method = "bun-file") {
    logger.info({ component, file: filePath, file_size_bytes: fileSize, mime: mimeType, method }, "Processing file");
}

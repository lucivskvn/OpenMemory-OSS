import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as cheerio from "cheerio";
import ffmpeg from "fluent-ffmpeg";
import mammoth from "mammoth";
import OpenAI from "openai";
import TurndownService from "turndown";

import { env } from "../core/cfg";
import { logger } from "../utils/logger";
import { validateUrl } from "../utils/security";

// Bun native file helpers
const bunExists = async (path: string) => {
    return await Bun.file(path).exists();
};
const bunUnlink = async (path: string) => {
    try {
        if (await bunExists(path)) {
            await fs.promises.unlink(path);
        }
    } catch (e) {
        if (env.verbose)
            logger.warn(`[EXTRACT] Failed to unlink ${path}:`, { error: e });
    }
};

export interface ExtractionConfig {
    maxSizeBytes?: number;
    // Add more config options as needed
}

export interface ExtractionResult {
    text: string;
    metadata: {
        contentType: string;
        charCount: number;
        estimatedTokens: number;
        extractionMethod: string;
        [key: string]: unknown;
    };
}

interface OpenAIAudioResponse {
    text: string;
    duration?: number;
    language?: string;
    [key: string]: unknown;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Extracts text and metadata from a PDF buffer.
 * Uses `pdf-parse`.
 *
 * @param buffer - The raw PDF file buffer.
 * @param config - Optional configuration (size limits).
 */
export async function extractPDF(
    buffer: Buffer,
    config?: { maxSizeBytes?: number },
): Promise<ExtractionResult> {
    const maxSize = config?.maxSizeBytes || 50 * 1024 * 1024; // Default 50MB
    if (buffer.length > maxSize) {
        throw new Error(
            `PDF file too large: ${(buffer.length / 1024 / 1024).toFixed(2)}MB. Limit is ${(maxSize / 1024 / 1024).toFixed(2)}MB.`,
        );
    }
    const pdf = (await import("pdf-parse")).default;
    const data = await pdf(buffer);

    return {
        text: data.text,
        metadata: {
            contentType: "pdf",
            charCount: data.text.length,
            estimatedTokens: estimateTokens(data.text),
            extractionMethod: "pdf-parse",
            pages: data.numpages,
            info: data.info,
            version: data.version,
        },
    };
}

/**
 * Extracts text from a DOCX buffer using `mammoth`.
 *
 * @param buffer - The raw DOCX file buffer.
 * @param config - Optional configuration (size limits).
 */
export async function extractDOCX(
    buffer: Buffer,
    config?: { maxSizeBytes?: number },
): Promise<ExtractionResult> {
    const maxSize = config?.maxSizeBytes || 20 * 1024 * 1024; // Default 20MB
    if (buffer.length > maxSize) {
        throw new Error(
            `DOCX file too large: ${(buffer.length / 1024 / 1024).toFixed(2)}MB. Limit is ${(maxSize / 1024 / 1024).toFixed(2)}MB.`,
        );
    }
    const result = await mammoth.extractRawText({ buffer });

    return {
        text: result.value,
        metadata: {
            contentType: "docx",
            charCount: result.value.length,
            estimatedTokens: estimateTokens(result.value),
            extractionMethod: "mammoth",
            messages: result.messages,
        },
    };
}

export async function extractHTML(html: string): Promise<ExtractionResult> {
    const $ = cheerio.load(html);

    // 1. Remove obvious noise globally
    $(
        "script, style, iframe, noscript, .ads, .cookie-banner, .sidebar, [role='complementary'], aside",
    ).remove();

    // 2. Identify main content candidates
    const selectors = ["article", "main", "#content", ".content", ".post", "#main", ".main"];
    let mainContent = $();

    for (const selector of selectors) {
        const found = $(selector).first();
        if (found.length > 0 && found.text().trim().length > 100) {
            mainContent = found;
            break;
        }
    }

    // 3. Remove navigational/footer noise from main content if found, but NOT globally yet 
    // (to preserve discovery if used elsewhere, although extractHTML is for CONTENT)
    if (mainContent.length > 0) {
        mainContent.find("nav, footer, header").remove();
    } else {
        // If no main content found, clean the body and use it
        $("nav, footer, header").remove();
        mainContent = $("body").length > 0 ? $("body") : $.root();
    }

    const cleanedHtml = mainContent.html() || html;

    const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
    });

    const markdown = turndown.turndown(cleanedHtml);

    return {
        text: markdown,
        metadata: {
            contentType: "html",
            charCount: markdown.length,
            estimatedTokens: estimateTokens(markdown),
            extractionMethod: "cheerio+turndown",
            originalHtmlLength: html.length,
        },
    };
}

/**
 * Fetches and extracts main content from a URL.
 * Uses `turndown` to convert HTML to Markdown.
 *
 * @param url - The URL to fetch.
 * @param config - Configuration (timeouts, size limits).
 */
export async function extractURL(
    url: string,
    config?: ExtractionConfig,
): Promise<ExtractionResult> {
    await validateUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
    const MAX_SIZE = config?.maxSizeBytes || 10 * 1024 * 1024; // Default 10MB

    try {
        const response = await fetch(url, {
            headers: {
                "User-Agent":
                    "OpenMemory/2.3.0 (Bot; +https://github.com/nullure/openmemory)",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        if (!response.body) throw new Error("Response body is empty");

        const chunks: string[] = [];
        let totalBytes = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_SIZE) {
                await reader.cancel();
                throw new Error(
                    `Response size exceeds limit of ${MAX_SIZE} bytes`,
                );
            }
            chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode()); // Flush
        const html = chunks.join("");

        const result = await extractHTML(html);

        return {
            ...result,
            metadata: {
                ...result.metadata,
                contentType: "url",
                extractionMethod: "node-fetch+turndown",
                sourceUrl: url,
                fetchedAt: new Date().toISOString(),
                fileSizeBytes: totalBytes,
            },
        };
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Extracts text from Audio using OpenAI Whisper API.
 *
 * @param buffer - The audio file buffer.
 * @param mimeType - The MIME type of the audio.
 * @param config - Config options.
 */
export async function extractAudio(
    buffer: Buffer,
    mimeType: string,
    config?: { maxSizeBytes?: number },
): Promise<ExtractionResult> {
    const apiKey = env.openaiKey;
    if (!apiKey) {
        throw new Error(
            "OpenAI API key required for audio transcription. Set OPENAI_API_KEY in .env",
        );
    }

    // Check file size (Whisper API limit is 25MB effectively, but we allow config override)
    const maxSize = config?.maxSizeBytes || 25 * 1024 * 1024; // Default 25MB
    if (buffer.length > maxSize) {
        throw new Error(
            `Audio file too large: ${(buffer.length / 1024 / 1024).toFixed(2)}MB. Limit is ${(maxSize / 1024 / 1024).toFixed(2)}MB.`,
        );
    }

    // Create temporary file for Whisper API
    const tempDir = os.tmpdir();
    const ext = getAudioExtension(mimeType);
    const tempFilePath = path.join(
        tempDir,
        `audio-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
    );

    try {
        // Write buffer to temp file
        await Bun.write(tempFilePath, buffer);

        // Initialize OpenAI client
        const openai = new OpenAI({ apiKey });

        // Transcribe audio using Whisper
        const transcription = (await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: "whisper-1",
            response_format: "verbose_json",
        })) as unknown as OpenAIAudioResponse;

        const text = transcription.text;

        return {
            text,
            metadata: {
                contentType: "audio",
                charCount: text.length,
                estimatedTokens: estimateTokens(text),
                extractionMethod: "whisper",
                audioFormat: ext.replace(".", ""),
                fileSizeBytes: buffer.length,
                fileSizeMb: (buffer.length / 1024 / 1024).toFixed(2),
                durationSeconds: transcription.duration || null,
                language: transcription.language || null,
            },
        };
    } catch (error: unknown) {
        logger.error("[EXTRACT] Audio transcription failed:", { error });
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Audio transcription failed: ${msg}`);
    } finally {
        // Clean up temp file
        await bunUnlink(tempFilePath);
    }
}

export async function extractVideo(
    buffer: Buffer,
    config?: { maxSizeBytes?: number },
): Promise<ExtractionResult> {
    const maxSize = config?.maxSizeBytes || 100 * 1024 * 1024; // Default 100MB
    if (buffer.length > maxSize) {
        throw new Error(
            `Video file too large: ${(buffer.length / 1024 / 1024).toFixed(2)}MB. Limit is ${(maxSize / 1024 / 1024).toFixed(2)}MB.`,
        );
    }
    // Create temporary files for video and audio
    const tempDir = os.tmpdir();
    const videoPath = path.join(tempDir, `video-${Date.now()}.mp4`);
    const audioPath = path.join(tempDir, `audio-${Date.now()}.mp3`);

    try {
        // Write video buffer to temp file
        await Bun.write(videoPath, buffer);

        // Extract audio using ffmpeg
        await new Promise<void>((resolve, reject) => {
            ffmpeg(videoPath)
                .output(audioPath)
                .noVideo()
                .audioCodec("libmp3lame")
                .on("end", () => resolve())
                .on("error", (err: Error) => reject(err))
                .run();
        });

        // Read extracted audio
        const audioBuffer = Buffer.from(
            await Bun.file(audioPath).arrayBuffer(),
        );

        // Transcribe extracted audio
        const result = await extractAudio(audioBuffer, "audio/mpeg");

        // Update metadata to reflect video source
        result.metadata.contentType = "video";
        result.metadata.extractionMethod = "ffmpeg+whisper";
        result.metadata.videoFileSizeBytes = buffer.length;
        result.metadata.videoFileSizeMb = (buffer.length / 1024 / 1024).toFixed(
            2,
        );

        return result;
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("ffmpeg")) {
            throw new Error(
                "FFmpeg not found. Please install FFmpeg to process video files. Visit: https://ffmpeg.org/download.html",
            );
        }
        logger.error("[EXTRACT] Video processing failed:", { error });
        throw new Error(`Video processing failed: ${msg}`);
    } finally {
        // Clean up temp files
        await Promise.all([bunUnlink(videoPath), bunUnlink(audioPath)]);
    }
}

function getAudioExtension(mimeType: string): string {
    const mimeMap: Record<string, string> = {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/wave": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp4": ".m4a",
        "audio/m4a": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
    };
    return mimeMap[mimeType.toLowerCase()] || ".mp3";
}

export async function extractText(
    contentType: string,
    data: string | Buffer,
    config?: ExtractionConfig,
): Promise<ExtractionResult> {
    const type = contentType.toLowerCase();

    const audioTypes = new Set([
        "mp3",
        "audio",
        "audio/mpeg",
        "audio/mp3",
        "audio/wav",
        "audio/wave",
        "audio/x-wav",
        "wav",
        "m4a",
        "audio/mp4",
        "audio/m4a",
        "audio/x-m4a",
        "webm",
        "audio/webm",
        "ogg",
        "audio/ogg",
    ]);

    const videoTypes = new Set([
        "mp4",
        "video",
        "video/mp4",
        "video/webm",
        "video/mpeg",
        "avi",
        "video/avi",
        "mov",
        "video/quicktime",
    ]);

    if (audioTypes.has(type)) {
        if (typeof data === "string" && data.length > 100 * 1024 * 1024) {
            throw new Error("Base64 audio data too large (>100MB). processing rejected to prevent OOM.");
        }
        const buffer = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as string, "base64");
        return extractAudio(
            buffer,
            type.startsWith("audio/") ? type : `audio/${type}`,
            config,
        );
    }

    if (videoTypes.has(type)) {
        if (typeof data === "string" && data.length > 100 * 1024 * 1024) {
            throw new Error("Base64 video data too large (>100MB). processing rejected to prevent OOM.");
        }
        const buffer = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as string, "base64");
        return extractVideo(buffer, config);
    }

    switch (type) {
        case "pdf":
        case "application/pdf":
            return extractPDF(
                Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data as string, "base64"),
                config,
            );

        case "docx":
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            return extractDOCX(
                Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data as string, "base64"),
                config,
            );

        case "doc":
        case "application/msword":
            logger.warn(
                "[EXTRACT] Legacy .doc file detected. Attempting to process as .docx (mammoth), which may fail.",
            );
            return extractDOCX(
                Buffer.isBuffer(data)
                    ? data
                    : Buffer.from(data as string, "base64"),
                config,
            );

        case "html":
        case "htm":
        case "text/html":
            return extractHTML(data.toString());

        case "md":
        case "markdown":
        case "text/markdown":
        case "text/x-markdown": {
            const text = data.toString();
            return {
                text,
                metadata: {
                    contentType: "markdown",
                    charCount: text.length,
                    estimatedTokens: estimateTokens(text),
                    extractionMethod: "passthrough",
                },
            };
        }

        case "txt":
        case "text":
        case "text/plain": {
            const text = data.toString();
            return {
                text,
                metadata: {
                    contentType: "txt",
                    charCount: text.length,
                    estimatedTokens: estimateTokens(text),
                    extractionMethod: "passthrough",
                },
            };
        }

        default:
            throw new Error(`Unsupported content type: ${contentType}`);
    }
}

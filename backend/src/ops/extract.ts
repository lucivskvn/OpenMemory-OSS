import { env } from "../core/cfg";
import { transcribeAudioWithOpenAI } from "../core/openai_adapter";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import * as pdf_parse from "pdf-parse";
const pdf = (pdf_parse as any).default ?? pdf_parse;
import mammoth from "mammoth";
import TurndownService from "turndown";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import { log } from "../core/log";



const turndownService = new TurndownService();

// Helper to check if buffer is binary
function isBinaryBuffer(buffer: Buffer): boolean {
    const chunk = buffer.subarray(0, Math.min(buffer.length, 1024));
    for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0) return true;
    }
    return false;
}

// Helper to save temp file
async function saveTempFile(buffer: Buffer, ext: string): Promise<string> {
    const tempDir = path.resolve(process.cwd(), "temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const tempFilePath = path.join(tempDir, `${uuidv4()}.${ext}`);
    try {
        await Bun.write(tempFilePath, buffer);
        return tempFilePath;
    } catch (e) {
        log.error("Failed to save temp file", { path: tempFilePath, error: e });
        throw e;
    }
}

async function removeFile(path: string) {
    try {
        if (fs.existsSync(path)) {
            await fsPromises.unlink(path);
        }
    } catch (e) {
        log.warn("Failed to delete temp file", { path, error: e });
    }
}

export const extract_text_from_pdf = async (buffer: Buffer): Promise<string> => {
    try {
        const data = await pdf(buffer);
        return data.text;
    } catch (e) {
        log.error("PDF extraction failed", { error: e });
        return "";
    }
};

export const extract_text_from_docx = async (buffer: Buffer): Promise<string> => {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    } catch (e) {
        log.error("DOCX extraction failed", { error: e });
        return "";
    }
};

export const extract_text_from_html = (html: string): string => {
    return turndownService.turndown(html);
};

export const transcribe_audio = async (buffer: Buffer): Promise<string> => {
    try {
        return await transcribeAudioWithOpenAI(buffer, "whisper-1");
    } catch (e) {
        log.error("Audio transcription failed", { error: e });
        return "";
    }
};

export const extract_audio_from_video = async (buffer: Buffer): Promise<Buffer> => {
    return new Promise(async (resolve, reject) => {
        let videoPath = "";
        let audioPath = "";
        try {
            videoPath = await saveTempFile(buffer, "mp4");
            audioPath = videoPath.replace(".mp4", ".mp3");

            ffmpeg(videoPath)
                .toFormat("mp3")
                .on("end", async () => {
                    try {
                        const audioBuffer = await Bun.file(audioPath).arrayBuffer();
                        await removeFile(videoPath);
                        await removeFile(audioPath);
                        resolve(Buffer.from(audioBuffer));
                    } catch (e) {
                        reject(e);
                    }
                })
                .on("error", async (err) => {
                    await removeFile(videoPath);
                    if (fs.existsSync(audioPath)) await removeFile(audioPath);
                    reject(err);
                })
                .save(audioPath);
        } catch (e) {
            // Cleanup in case of setup failure
            if (videoPath) await removeFile(videoPath);
            reject(e);
        }
    });
};

export const processBuffer = async (buffer: Buffer, ext: string): Promise<string> => {
    const e = ext.toLowerCase().replace(".", "");
    if (e === "pdf") return await extract_text_from_pdf(buffer);
    if (e === "docx") return await extract_text_from_docx(buffer);
    if (["html", "htm"].includes(e)) return extract_text_from_html(buffer.toString());
    if (["mp3", "wav", "m4a", "ogg"].includes(e)) return await transcribe_audio(buffer);
    if (["mp4", "mov", "avi", "webm"].includes(e)) {
        const audio = await extract_audio_from_video(buffer);
        return await transcribe_audio(audio);
    }
    // Default to treating as text for unknown types, assuming text content
    if (isBinaryBuffer(buffer)) {
        throw new Error(`Unsupported binary file type: ${ext || "unknown"}`);
    }
    return buffer.toString();
};

export const process_file = async (
    file: { name: string; type?: string; arrayBuffer: () => Promise<ArrayBuffer> },
): Promise<string> => {
    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    return processBuffer(buffer, ext);
};

export interface ExtractionResult {
    text: string;
    metadata: {
        title?: string;
        source_url?: string;
        content_type: string;
        estimated_tokens: number;
        [key: string]: any;
    };
}

const estimateTokens = (t: string) => Math.ceil(t.length / 4);

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit

export const extractText = async (textOrUrlOrType: string, data?: string | Buffer): Promise<ExtractionResult> => {
    let text = "";
    let type = "text";

    if (data) {
        type = textOrUrlOrType;
        let buf: Buffer;

        if (Buffer.isBuffer(data)) {
            buf = data;
        } else {
            // Check if binary type to decide on base64 decoding
            const binaryTypes = ["pdf", "docx", "audio", "mp3", "wav", "mp4", "mov", "avi"];
            const isBinary = binaryTypes.some(t => type.toLowerCase().includes(t));

            if (isBinary) {
                buf = Buffer.from(data, 'base64');
            } else {
                buf = Buffer.from(data);
            }
        }

        if (buf.length > MAX_FILE_SIZE) {
            throw new Error(`File too large: ${buf.length} bytes (max ${MAX_FILE_SIZE})`);
        }

        text = await processBuffer(buf, type);
    } else {
        // No data, assume textOrUrlOrType is the text content
        text = textOrUrlOrType;
    }

    return {
        text,
        metadata: {
            content_type: type,
            estimated_tokens: estimateTokens(text)
        }
    };
};

export const extractURL = async (url: string): Promise<ExtractionResult> => {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const len = res.headers.get("content-length");
        if (len && parseInt(len) > MAX_FILE_SIZE) {
            throw new Error(`URL content too large (${len} bytes)`);
        }

        const blob = await res.blob();
        if (blob.size > MAX_FILE_SIZE) {
            throw new Error(`URL content too large (${blob.size} bytes)`);
        }

        const html = await blob.text();
        const text = extract_text_from_html(html);
        return {
            text,
            metadata: {
                title: url,
                source_url: url,
                content_type: "html",
                estimated_tokens: estimateTokens(text)
            }
        };
    } catch (e) {
        log.error("URL extraction failed", { error: e });
        throw e;
    }
};

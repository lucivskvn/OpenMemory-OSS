import OpenAI from "openai";
import { env } from "../core/cfg";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import * as pdf_parse from "pdf-parse";
const pdf = pdf_parse.default || pdf_parse;
import mammoth from "mammoth";
import TurndownService from "turndown";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "node:fs";
import { log } from "../core/log";

// Setup OpenAI for Whisper
const openai = new OpenAI({
    apiKey: env.openai_key,
    baseURL: env.openai_base_url,
});

const turndownService = new TurndownService();

// Helper to save temp file
async function saveTempFile(buffer: Buffer, ext: string): Promise<string> {
    const tempDir = path.resolve(process.cwd(), "temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const tempFilePath = path.join(tempDir, `${uuidv4()}.${ext}`);
    await Bun.write(tempFilePath, buffer);
    return tempFilePath;
}

async function removeFile(path: string) {
    try {
        const file = Bun.file(path);
        if (await file.exists()) {
            fs.unlinkSync(path);
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
        // Create a File object directly from buffer (supported in Bun)
        const file = new File([buffer], "audio.mp3", { type: "audio/mp3" });
        const response = await openai.audio.transcriptions.create({
            file: file,
            model: "whisper-1",
        });
        return response.text;
    } catch (e) {
        log.error("Audio transcription failed", { error: e });
        return "";
    }
};

export const extract_audio_from_video = async (buffer: Buffer): Promise<Buffer> => {
    return new Promise(async (resolve, reject) => {
        const videoPath = await saveTempFile(buffer, "mp4");
        const audioPath = videoPath.replace(".mp4", ".mp3");

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
                if (await Bun.file(audioPath).exists()) await removeFile(audioPath);
                reject(err);
            })
            .save(audioPath);
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
    // Default to treating as text
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
            // ingest_req sends strings. If it's a binary format, we expect base64.
            const binaryTypes = ["pdf", "docx", "audio", "mp3", "wav", "mp4", "mov", "avi"];
            const isBinary = binaryTypes.some(t => type.toLowerCase().includes(t));

            if (isBinary) {
                buf = Buffer.from(data, 'base64');
            } else {
                buf = Buffer.from(data);
            }
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
        const html = await res.text();
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

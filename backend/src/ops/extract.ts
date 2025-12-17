import OpenAI from "openai";
import { env } from "../core/cfg";
import path from "path";
import { v4 as uuidv4 } from "uuid";
// @ts-ignore
import pdf from "pdf-parse";
import mammoth from "mammoth";
import TurndownService from "turndown";
import ffmpeg from "fluent-ffmpeg";
import * as fs from "node:fs"; // Import node:fs properly

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
        console.warn("Failed to delete temp file", path, e);
    }
}

export const extract_text_from_pdf = async (buffer: Buffer): Promise<string> => {
    try {
        const data = await pdf(buffer);
        return data.text;
    } catch (e) {
        console.error("PDF extraction failed", e);
        return "";
    }
};

export const extract_text_from_docx = async (buffer: Buffer): Promise<string> => {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    } catch (e) {
        console.error("DOCX extraction failed", e);
        return "";
    }
};

export const extract_text_from_html = (html: string): string => {
    return turndownService.turndown(html);
};

export const transcribe_audio = async (buffer: Buffer): Promise<string> => {
    const tempFilePath = await saveTempFile(buffer, "mp3");
    try {
        const file = new File([buffer], "audio.mp3", { type: "audio/mp3" });
        const response = await openai.audio.transcriptions.create({
            file: file,
            model: "whisper-1",
        });
        return response.text;
    } catch (e) {
        console.error("Audio transcription failed", e);
        return "";
    } finally {
        await removeFile(tempFilePath);
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

export const process_file = async (
    file: { name: string; type: string; arrayBuffer: () => Promise<ArrayBuffer> },
): Promise<string> => {
    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "pdf") return await extract_text_from_pdf(buffer);
    if (ext === "docx") return await extract_text_from_docx(buffer);
    if (["html", "htm"].includes(ext || ""))
        return extract_text_from_html(buffer.toString());
    if (["mp3", "wav", "m4a", "ogg"].includes(ext || ""))
        return await transcribe_audio(buffer);
    if (["mp4", "mov", "avi", "webm"].includes(ext || "")) {
        const audio = await extract_audio_from_video(buffer);
        return await transcribe_audio(audio);
    }
    if (["txt", "md", "json", "csv", "xml"].includes(ext || ""))
        return buffer.toString();

    return "";
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

export const extractText = async (textOrUrl: string, data?: string | Buffer): Promise<ExtractionResult> => {
    let text = "";
    if (data) {
        if (typeof data === "string") text = data;
        else if (Buffer.isBuffer(data)) text = data.toString();
        else text = String(data);
    } else {
        text = textOrUrl;
    }

    return {
        text,
        metadata: {
            content_type: "text",
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
        console.error("URL extraction failed", e);
        throw e;
    }
};

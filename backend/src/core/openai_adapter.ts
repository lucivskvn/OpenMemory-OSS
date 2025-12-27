import { env } from "./cfg";
import { fetchWithTimeout } from "../memory/embed";
import fs from "fs";

// Minimal adapter to abstract OpenAI client differences between versions.
// We provide a single function transcribeAudio(file, model) that tries to use
// an installed OpenAI client if available, else falls back to the REST API.

export const transcribeAudioWithOpenAI = async (file: File | Blob | Buffer, model = "whisper-1") => {
    // If there's no key, throw to allow callers to gracefully handle fallback
    if (!env.openai_key) throw new Error("OpenAI key missing for transcription");

    // Try to require the official client (works for v4/v5/v6) if installed
    try {
        // Import dynamically to avoid startup issues
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const OpenAI = require("openai");
        if (OpenAI) {
            const client = new OpenAI({ apiKey: env.openai_key, baseURL: env.openai_base_url });
            // v4 used client.audio.transcriptions.create, v6 might expose different paths.
            // Try known patterns safely.
            if (client?.audio?.transcriptions?.create) {
                const response = await client.audio.transcriptions.create({ file: file as any, model });
                // Different clients may return string directly or under .text
                return (response as any).text || (response as any).data?.text || "";
            }
            if (client?.speech?.transcriptions?.create) {
                const response = await client.speech.transcriptions.create({ file: file as any, model });
                return (response as any).text || (response as any).data?.text || "";
            }
        }
    } catch (e) {
        // ignore and fall back to REST API
    }

    // REST fallback: send multipart/form-data to /audio/transcriptions endpoint
    try {
        const form = new FormData();
        if (file instanceof Buffer) {
            const blob = new Blob([file]);
            form.append("file", blob, "audio.mp3");
        } else {
            form.append("file", file as any);
        }
        form.append("model", model);

        const url = `${env.openai_base_url.replace(/\/$/, "")}/audio/transcriptions`;
        const res = await fetchWithTimeout(url, {
            method: "POST",
            headers: { authorization: `Bearer ${env.openai_key}` },
            body: form as any,
        });
        if (!res.ok) throw new Error(`OpenAI REST transcription failed: ${res.status}`);
        const json = await res.json();
        return json.text || json?.data?.text || "";
    } catch (e: any) {
        throw e;
    }
};

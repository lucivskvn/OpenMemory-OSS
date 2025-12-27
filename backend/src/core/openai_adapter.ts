import OpenAI from "openai";
import { env } from "./cfg";
import { log } from "./log";

/**
 * Transcribe audio buffer using OpenAI. Tries official client first, then falls back
 * to a REST multipart POST to /v1/audio/transcriptions. Returns empty string on failure.
 */
export async function transcribeAudioWithOpenAI(
  buffer: Buffer,
  model = "whisper-1",
  timeoutMs = 30_000,
): Promise<string> {
  if (!env.openai_key) throw new Error("OpenAI key missing");

  // Create a File object from buffer (Bun/browser compatible) using Uint8Array to satisfy TS BlobPart types
  const file = new File([new Uint8Array(buffer)], "audio.mp3", { type: "audio/mpeg" });

  // Try the official OpenAI client first (supports multiple client shapes)
  try {
    const client = new OpenAI({ apiKey: env.openai_key, baseURL: env.openai_base_url });

    // Many client versions expose audio.transcriptions.create
    // Try to call it if available
    // @ts-ignore - client shapes differ across versions
    if (client?.audio?.transcriptions?.create) {
      // @ts-ignore
      const res: any = await client.audio.transcriptions.create({ file, model });

      if (!res) throw new Error("empty response from client.transcriptions.create");
      if (typeof res === "string") return res;
      if (res.text) return res.text;
      if (res.data?.[0]?.text) return res.data[0].text;
    }
  } catch (err: any) {
    log.warn("[OpenAI Adapter] client transcription failed, falling back to REST", { error: err?.message || err });
  }

  // Fallback to direct REST multipart POST
  try {
    const endpoint = (env.openai_base_url || "https://api.openai.com") + "/v1/audio/transcriptions";
    const fd = new FormData();
    fd.append("file", file as any);
    fd.append("model", model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openai_key}`,
      },
      body: fd as any,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI transcription failed: ${res.status} ${body}`);
    }

    const data = await res.json();

    if (data?.text) return data.text;
    if (data?.data?.[0]?.text) return data.data[0].text;

    // Attempt to find a string field with the transcription
    for (const key of Object.keys(data)) {
      const v = (data as any)[key];
      if (typeof v === "string") return v;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item?.text) return item.text;
        }
      }
    }

    throw new Error("OpenAI transcription returned unexpected payload");
  } catch (err: any) {
    log.error("[OpenAI Adapter] transcription failed", { error: err?.message || err });
    return "";
  }
}

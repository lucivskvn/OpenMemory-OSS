import OpenAI from "openai";

export async function transcribeAudioWithOpenAI(buffer: Buffer, apiKey?: string, baseURL?: string) {
    const key = apiKey || process.env.OPENAI_API_KEY || process.env.OM_OPENAI_API_KEY;
    if (!key) throw new Error("OpenAI key missing");

    const file = new File([buffer], "audio.mp3", { type: "audio/mpeg" });

    try {
        const client = new OpenAI({ apiKey: key, baseURL });
        // @ts-ignore
        if (client?.audio?.transcriptions?.create) {
            // @ts-ignore
            const res: any = await client.audio.transcriptions.create({ file, model: "whisper-1" });
            if (res?.text) return res.text;
            if (res?.data?.[0]?.text) return res.data[0].text;
        }
    } catch (e) {
        // fallthrough to REST
    }

    const endpoint = (baseURL || process.env.OM_OPENAI_BASE_URL || "https://api.openai.com") + "/v1/audio/transcriptions";
    const fd = new FormData();
    fd.append("file", file as any);
    fd.append("model", "whisper-1");

    const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: fd as any,
    });
    if (!res.ok) throw new Error(`OpenAI transcription failed: ${res.status}`);
    const data = await res.json();
    if (data?.text) return data.text;
    if (data?.data?.[0]?.text) return data.data[0].text;
    throw new Error("OpenAI transcription returned unexpected payload");
}

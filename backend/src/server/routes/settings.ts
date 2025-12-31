import { env } from "../../core/cfg";
import path from "path";
import { Elysia, t } from "elysia";
import { log } from "../../core/log";

const ENV_PATH = path.resolve(process.cwd(), ".env");

export const settings = new Elysia({ prefix: "/api/settings" })
    .get("/", async ({ error }) => {
        try {
            const file = Bun.file(ENV_PATH);
            const exists = await file.exists();
            let settings: Record<string, string> = {};

            if (exists) {
                const content = await file.text();
                content.split("\n").forEach((line) => {
                    const match = line.match(/^\s*([^#=]+)\s*=(.*)$/);
                    if (match) {
                        const k = match[1].trim();
                        const v = match[2].trim();
                        if (k) settings[k] = v;
                    }
                });
            }

            // Merge process.env for relevant keys that might be set in environment (e.g. via Docker or test)
            // ensuring dashboard sees effective config even if not in .env file
            const keysToInclude = ["OM_PG_HOST", "OM_PG_USER", "OM_PG_PORT", "OM_PG_DB", "OM_METADATA_BACKEND"];
            for (const k of keysToInclude) {
                if (process.env[k] && !settings[k]) {
                    settings[k] = process.env[k]!;
                }
            }

            // Filter Postgres settings if not in Postgres mode
            const metaBackend = process.env.OM_METADATA_BACKEND || "sqlite";
            if (metaBackend !== "postgres") {
                 for (const k of Object.keys(settings)) {
                     if (k.startsWith("OM_PG_")) {
                         delete settings[k];
                     }
                 }
            }

            // Mask sensitive
            const sensitive = ["API_KEY", "SECRET", "PASSWORD", "KEY_ID", "TOKEN"];
            for (const k of Object.keys(settings)) {
                if (sensitive.some((s) => k.toUpperCase().includes(s))) {
                    if (settings[k] && settings[k].length > 0) settings[k] = "***";
                }
            }

            return { exists, settings };
        } catch (e: any) {
            log.error("[SETTINGS] Read error:", { error: e });
            return error(500, { error: "internal", message: e.message });
        }
    })
    .post(
        "/",
        async ({ body, set }) => {
            try {
                const updates = body as Record<string, string>;

                // Validate no newlines
                for (const [k, v] of Object.entries(updates)) {
                    if (v.includes("\n") || v.includes("\r")) {
                        set.status = 400;
                        return { error: "invalid_value", message: "Values cannot contain newlines" };
                    }
                }

                let content = "";
                const envFile = Bun.file(ENV_PATH);

                if (await envFile.exists()) {
                    content = await envFile.text();
                } else {
                    const examplePath = path.resolve(process.cwd(), ".env.example");
                    const exampleFile = Bun.file(examplePath);
                    if (await exampleFile.exists()) {
                        content = await exampleFile.text();
                    }
                }

                const lines = content.split("\n");
                const newLines: string[] = [];
                const seenKeys = new Set<string>();

                for (const line of lines) {
                    const match = line.match(/^\s*([^#=]+)\s*=(.*)$/);
                    if (match) {
                        const key = match[1].trim();
                        if (updates[key] !== undefined) {
                            if (updates[key] !== "***" && updates[key] !== "******") {
                                newLines.push(`${key}=${updates[key]}`);
                            } else {
                                newLines.push(line);
                            }
                            seenKeys.add(key);
                        } else {
                            newLines.push(line);
                        }
                    } else {
                        newLines.push(line);
                    }
                }

                for (const [key, val] of Object.entries(updates)) {
                    if (!seenKeys.has(key) && val !== "***" && val !== "******") {
                        newLines.push(`${key}=${val}`);
                    }
                }

                await Bun.write(ENV_PATH, newLines.join("\n"));

                return {
                    ok: true,
                    message: "Settings saved. Restart the backend to apply changes.",
                };
            } catch (e: any) {
                log.error("[SETTINGS] Write error:", { error: e });
                set.status = 500;
                return { error: "internal", message: e.message };
            }
        },
        {
            body: t.Record(t.String(), t.String()),
        },
    );

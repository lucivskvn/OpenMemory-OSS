import { Elysia, t } from "elysia";
import { log } from "../../core/log";
import { env } from "../../core/cfg";
import fs from "node:fs";
import path from "node:path";

export const settings = (app: Elysia) =>
    app.group("/api/settings", (app) =>
        app
            .get("/", () => {
                // Return current env vars, masking sensitive ones
                // Dashboard expects raw env var names (OM_PORT, etc.)
                const rawEnv = { ...process.env };

                const sensitive = [
                    "api_key", "openai_key", "gemini_key", "AWS_SECRET_ACCESS_KEY",
                    "valkey_password", "OM_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY",
                    "OM_VALKEY_PASSWORD", "OM_WEAVIATE_API_KEY", "AWS_SECRET_ACCESS_KEY"
                ];

                // Mask sensitive
                for (const k of Object.keys(rawEnv)) {
                    if (sensitive.some(s => k.toLowerCase().includes(s.toLowerCase()))) {
                        if (rawEnv[k] && rawEnv[k] !== "") rawEnv[k] = "***";
                    }
                }

                return { settings: rawEnv };
            })
            .post("/", async ({ body, set }) => {
                try {
                    const newSettings = body as Record<string, string>;
                    const envPath = path.resolve(process.cwd(), ".env");

                    let envContent = "";
                    if (fs.existsSync(envPath)) {
                        envContent = fs.readFileSync(envPath, "utf-8");
                    }

                    const lines = envContent.split("\n");
                    const newLines = [];
                    const seenKeys = new Set();

                    // Update existing lines
                    for (const line of lines) {
                        const match = line.match(/^([^=]+)=(.*)$/);
                        if (match) {
                            const key = match[1].trim();
                            if (newSettings[key] !== undefined) {
                                // If value is masked, skip update
                                if (newSettings[key] !== "***" && newSettings[key] !== "******") {
                                    newLines.push(`${key}=${newSettings[key]}`);
                                } else {
                                    newLines.push(line); // Keep original
                                }
                                seenKeys.add(key);
                            } else {
                                newLines.push(line);
                            }
                        } else {
                            newLines.push(line);
                        }
                    }

                    // Append new keys
                    for (const [key, val] of Object.entries(newSettings)) {
                        if (!seenKeys.has(key) && val !== "***" && val !== "******") {
                            newLines.push(`${key}=${val}`);
                        }
                    }

                    fs.writeFileSync(envPath, newLines.join("\n"));
                    // Audit log: record which keys changed (do not log values)
                    const updatedKeys = Object.keys(newSettings).filter(k => !seenKeys.has(k) || newLines.some(line => line.startsWith(k + "=")));
                    log.info("Settings updated via API", { updatedKeys });

                    return { message: "Settings saved. Please restart the server." };
                } catch (e: any) {
                    log.error("Failed to save settings", { error: e.message });
                    set.status = 500;
                    return { error: "Failed to save settings" };
                }
            }, {
                body: t.Record(t.String(), t.String())
            })
    );

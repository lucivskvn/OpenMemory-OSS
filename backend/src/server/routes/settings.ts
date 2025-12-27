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

                const { SENSITIVE_PATTERNS } = require("../../core/secrets");

                // Mask sensitive
                for (const k of Object.keys(rawEnv)) {
                    if (SENSITIVE_PATTERNS.some(s => k.toLowerCase().includes(s.toLowerCase()))) {
                        if (rawEnv[k] && rawEnv[k] !== "") rawEnv[k] = "***";
                    }
                }

                return { settings: rawEnv };
            })
            .post("/", async ({ body, set }) => {
                try {
                    const newSettings = body as Record<string, string>;
                    const envPath = path.resolve(process.cwd(), ".env");

                    // Validation: ensure keys are safe and values do not contain newlines
                    for (const [k, v] of Object.entries(newSettings)) {
                        if (!/^[A-Z0-9_]+$/.test(k)) {
                            set.status = 400;
                            return { error: 'invalid_key', message: `Invalid env key: ${k}` };
                        }
                        if (typeof v === 'string' && (v.includes('\n') || v.includes('\r'))) {
                            set.status = 400;
                            return { error: 'invalid_value', message: `Env value for ${k} contains prohibited characters` };
                        }
                    }

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

                    // Atomic write: write to temp file then rename, set file perms to 600
                    const tmpPath = envPath + ".tmp";
                    fs.writeFileSync(tmpPath, newLines.join("\n"), { mode: 0o600 });
                    fs.renameSync(tmpPath, envPath);

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

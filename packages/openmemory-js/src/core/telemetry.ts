/**
 * @file Anonymous telemetry for OpenMemory usage analytics.
 *
 * Telemetry is opt-out and can be disabled via `OM_TELEMETRY=false`.
 * All identifying information (hostname) is SHA-256 hashed before transmission.
 *
 * Data collected:
 * - Anonymized host identifier
 * - OS platform
 * - Embedding provider in use
 * - Metadata backend type
 * - Package version
 * - System RAM/CPU info
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger";
import { env } from "./cfg";

const DISABLED = !env.telemetryEnabled;


let versionCache: string | null = null;

const gatherVersion = async (): Promise<string> => {
    if (versionCache) return versionCache;

    // 1. Try environment variable (common in CI/CD)
    if (process.env.npm_package_version) {
        versionCache = process.env.npm_package_version;
        return versionCache;
    }

    // 2. Try reading package.json relative to current file
    try {
        const pkgPath = path.resolve(__dirname, "../../package.json");
        const exists = await fs
            .stat(pkgPath)
            .then(() => true)
            .catch(() => false);

        if (exists) {
            const content = await fs.readFile(pkgPath, "utf-8");
            try {
                const json = JSON.parse(content);
                versionCache = json.version || "unknown";
                return versionCache!;
            } catch {
                // partial read or bad json
            }
        }
    } catch {
        /* ignore */
    }

    // 3. Fallback to hardcoded version if bundled or file access fails
    versionCache = "2.3.0";
    return versionCache;
};

export const sendTelemetry = async () => {
    if (DISABLED) return;
    try {
        const ramMb = Math.round(os.totalmem() / (1024 * 1024));
        const storageMb = ramMb * 4;

        // anonymize hostname
        const hostHash = crypto
            .createHash("sha256")
            .update(os.hostname())
            .digest("hex")
            .substring(0, 12);

        const payload = {
            name: hostHash,
            os: os.platform(),
            embeddings: ["openai", "anthropic", "gemini", "ollama", "local", "synthetic"].includes(env.embKind) ? env.embKind : "custom",
            metadata: env.metadataBackend || "sqlite",
            version: await gatherVersion(),
            ram: ramMb,
            storage: storageMb,
            cpu: os.cpus()?.[0]?.model || "unknown",
            uptime: process.uptime(),
            loadavg: os.loadavg(),
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

        const res = await fetch(env.telemetryEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true,
            signal: controller.signal,
        }).finally(() => clearTimeout(timeout));

        if (res.ok && env.verbose) {
            logger.info(`[TELEMETRY] Sent successfully`);
        }
    } catch {
        // silently ignore telemetry errors
    }
};

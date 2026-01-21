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


import * as os from "node:os";
import * as path from "node:path";

import { logger } from "../utils/logger";
import { env, VERSION } from "./cfg";

const DISABLED = !env.telemetryEnabled;


let versionCache: string | null = null;

const gatherVersion = async (): Promise<string> => {
    if (versionCache) return versionCache;

    // 1. Try environment variable (common in CI/CD)
    if (Bun.env.npm_package_version) {
        versionCache = Bun.env.npm_package_version;
        return versionCache;
    }

    // 2. Try reading package.json relative to current file
    try {
        const pkgPath = path.resolve(import.meta.dir, "../../package.json");
        const file = Bun.file(pkgPath);

        if (await file.exists()) {
            try {
                const json = await file.json();
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
    versionCache = VERSION;
    return versionCache;
};

export const sendTelemetry = async () => {
    if (DISABLED) return;
    try {
        const ramMb = Math.round(os.totalmem() / (1024 * 1024));
        const storageMb = ramMb * 4;

        // anonymize hostname
        // anonymize hostname
        const hostHash = await (async () => {
            const enc = new TextEncoder();
            const hash = await globalThis.crypto.subtle.digest("SHA-256", enc.encode(os.hostname()));
            return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 12);
        })();

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

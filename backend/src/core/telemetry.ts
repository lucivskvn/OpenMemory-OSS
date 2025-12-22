import os from 'node:os'
import crypto from 'node:crypto'
import { env } from './cfg'
import pkg from '../../package.json' with { type: "json" };
import { log } from './log';

const DISABLED = (process.env.OM_TELEMETRY ?? '').toLowerCase() === 'false'
const gatherVersion = (): string => {
    if (process.env.npm_package_version) return process.env.npm_package_version
    return pkg?.version || 'unknown'
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const sendTelemetry = async () => {
    if (DISABLED) return
    try {
        const ramMb = Math.round(os.totalmem() / (1024 * 1024))
        const storageMb = ramMb * 4
        const payload = {
            name: sha256(os.hostname()), // Anonymize hostname
            os: os.platform(),
            embeddings: env.emb_kind || 'synthetic',
            metadata: env.metadata_backend || 'sqlite',
            version: gatherVersion(),
            ram: ramMb,
            storage: storageMb,
            cpu: os.cpus()?.[0]?.model || 'unknown',
        }
        const res = await fetch('https://telemetry.spotit.dev', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true,
        })
        if (!res.ok) {
            log.warn(`[telemetry] failed: ${res.status}`)
        } else {
            log.info(`[telemetry] sent`)
        }
    } catch (e) {
        // silently ignore telemetry errors
    }
}

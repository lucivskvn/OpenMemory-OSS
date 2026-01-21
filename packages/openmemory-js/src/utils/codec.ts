/**
 * @file codec.ts
 * @description Encoding, decoding and hydration utilities for OpenMemory.
 * @audited 2026-01-19
 */

import { EncryptionProvider } from "../core/security";

/**
 * Hydrates encrypted/stringified metadata into a structured object.
 * Handles:
 * 1. Stringified JSON patterns (including encrypted shells).
 * 2. Already parsed objects.
 * 3. Fallback to raw string or object if decryption/parsing fails.
 * 
 * @param rawMeta The raw metadata from database or API.
 * @param enc Optional EncryptionProvider for decryption.
 * @returns A structured record of metadata.
 */
export async function hydrateMetadata(
    rawMeta: unknown,
    enc?: EncryptionProvider
): Promise<Record<string, unknown>> {
    if (!rawMeta) return {};

    let meta: Record<string, unknown> = {};

    try {
        // Case 1: metadata is already an object
        if (typeof rawMeta === 'object' && rawMeta !== null) {
            // Check if it's an encrypted shell
            if (enc && 'iv' in (rawMeta as any) && 'content' in (rawMeta as any)) {
                const dec = await enc.decrypt(JSON.stringify(rawMeta));
                meta = JSON.parse(dec);
            } else {
                meta = rawMeta as Record<string, unknown>;
            }
        }
        // Case 2: metadata is still a string
        else if (typeof rawMeta === 'string') {
            if (enc && rawMeta.startsWith('{"iv":')) {
                const dec = await enc.decrypt(rawMeta);
                meta = JSON.parse(dec);
            } else {
                meta = JSON.parse(rawMeta);
            }
        }
    } catch (e) {
        // Fallback: keep raw metadata if possible, or use raw string
        meta = (typeof rawMeta === 'object' && rawMeta !== null)
            ? rawMeta as Record<string, unknown>
            : { _raw: String(rawMeta) };
    }

    return meta;
}

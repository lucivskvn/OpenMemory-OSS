import crypto from "node:crypto";
import { env } from "./config";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:";

function getEncryptionKey(): Buffer | null {
    if (!env.OM_ENCRYPTION_KEY) {
        return null;
    }
    const keyStr = env.OM_ENCRYPTION_KEY;
    const buf = Buffer.from(keyStr, "utf8");
    if (buf.length === 32) {
        return buf;
    }

    // Some runtimes (like Bun's crypto shim or Node) might complain about key lengths
    // if we just pass a hash buffer directly without ensuring it's a 32-byte typed array buffer slice correctly.
    // However, crypto.createHash('sha256').digest() returns a 32 byte buffer.
    const digest = crypto.createHash("sha256").update(keyStr).digest();
    return Buffer.from(digest);
}

const key = getEncryptionKey();

export function encrypt(text: string): string {
    if (!key) {
        return text;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    return `${PREFIX}${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
    if (!key || !ciphertext.startsWith(PREFIX)) {
        return ciphertext;
    }

    try {
        const parts = ciphertext.substring(PREFIX.length).split(":");
        if (parts.length !== 3) {
            return ciphertext;
        }

        const iv = Buffer.from(parts[0], "hex");
        const authTag = Buffer.from(parts[1], "hex");
        const encryptedText = parts[2];

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedText, "hex", "utf8");
        decrypted += decipher.final("utf8");

        return decrypted;
    } catch (e) {
        console.error("[CRYPTO] Decryption failed:", e);
        return ciphertext; // Fallback to raw if decryption fails for some reason
    }
}

import { expect, test, describe, beforeAll } from "bun:test";
import { GithubSource } from "../../src/sources/github";
import { createHmac } from "crypto";

describe("Webhook Security Verification", () => {
    const SECRET = "test-webhook-secret";

    test("GitHub Signature Verification (Valid)", async () => {
        const payload = JSON.stringify({ event: "push", ref: "refs/heads/main" });
        const hmac = createHmac('sha256', SECRET);
        const signature = 'sha256=' + hmac.update(payload).digest('hex');

        const isValid = await GithubSource.verifySignature(signature, payload, SECRET);
        expect(isValid).toBe(true);
    });

    test("GitHub Signature Verification (Invalid Signature)", async () => {
        const payload = JSON.stringify({ event: "push" });
        const isValid = await GithubSource.verifySignature("sha256=wrong", payload, SECRET);
        expect(isValid).toBe(false);
    });

    test("GitHub Signature Verification (Invalid Payload)", async () => {
        const payload = JSON.stringify({ event: "push" });
        const hmac = createHmac('sha256', SECRET);
        const signature = 'sha256=' + hmac.update(payload).digest('hex');

        const isValid = await GithubSource.verifySignature(signature, payload + "modified", SECRET);
        expect(isValid).toBe(false);
    });

    test("GitHub Signature Verification (Empty Secret)", async () => {
        const payload = JSON.stringify({ event: "push" });
        const isValid = await GithubSource.verifySignature("sig", payload, "");
        expect(isValid).toBe(false);
    });
});

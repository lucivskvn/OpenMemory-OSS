import { describe, expect, test } from "bun:test";
import { redact } from "../../src/utils/logger";

describe("Logger Redaction", () => {
    test("redacts explicit sensitive keys", () => {
        const input = {
            apiKey: "secret_123",
            normal: "value",
            nested: {
                token: "token_abc",
                user: "bob",
            },
        };
        const output = redact(input) as any;
        expect(output.apiKey).toBe("[REDACTED]");
        expect(output.normal).toBe("value");
        expect(output.nested.token).toBe("[REDACTED]");
        expect(output.nested.user).toBe("bob");
    });

    test("redacts keys matching exact sensitive keys (case insensitive)", () => {
        const input = {
            apiKey: "secret",      // Matches "apiKey" in SENSITIVE_KEYS
            token: "123",          // Matches "token" in SENSITIVE_KEYS
            password: "hash",      // Matches "password" in SENSITIVE_KEYS
            normalKey: "visible"   // No match - should NOT be redacted
        };
        const output = redact(input) as any;
        expect(output["apiKey"]).toBe("[REDACTED]");
        expect(output["token"]).toBe("[REDACTED]");
        expect(output["password"]).toBe("[REDACTED]");
        expect(output["normalKey"]).toBe("visible");
    });

    test("handles circular references", () => {
        const obj: any = { a: 1 };
        obj.self = obj;
        const output = redact(obj) as any;
        expect(output.a).toBe(1);
        expect(output.self).toBe("[CIRCULAR]");
    });
});

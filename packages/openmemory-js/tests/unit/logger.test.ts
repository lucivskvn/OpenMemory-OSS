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
        expect(output.apiKey).toBe("***REDACTED***");
        expect(output.normal).toBe("value");
        expect(output.nested.token).toBe("***REDACTED***");
        expect(output.nested.user).toBe("bob");
    });

    test("redacts keys containing sensitive strings insensitive case", () => {
        const input = {
            my_API_Key: "secret",
            AuthToken: "123",
            user_Password_hash: "hash",
        };
        const output = redact(input) as any;
        expect(output["my_API_Key"]).toBe("***REDACTED***");
        expect(output["AuthToken"]).toBe("***REDACTED***");
        expect(output["user_Password_hash"]).toBe("***REDACTED***");
    });

    test("handles circular references", () => {
        const obj: any = { a: 1 };
        obj.self = obj;
        const output = redact(obj) as any;
        expect(output.a).toBe(1);
        expect(output.self).toBe("[Circular]");
    });
});

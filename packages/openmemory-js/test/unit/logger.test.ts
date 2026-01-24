import { describe, expect, test } from "bun:test";
import { redact, containsPII, detectPIITypes, sanitizeForStorage } from "../../src/utils/logger";

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

    test("redacts email addresses in strings", () => {
        const input = "Contact us at support@example.com for help";
        const output = redact(input) as string;
        expect(output).toContain("su***@example.com");
        expect(output).not.toContain("support@example.com");
    });

    test("redacts phone numbers in strings", () => {
        const input = "Call us at (555) 123-4567 or 555.123.4567";
        const output = redact(input) as string;
        expect(output).toContain("***-***-****");
        expect(output).not.toContain("555");
    });

    test("redacts SSN patterns", () => {
        const input = "SSN: 123-45-6789 or 123456789";
        const output = redact(input) as string;
        expect(output).toContain("***-**-****");
        expect(output).not.toContain("123-45-6789");
    });

    test("redacts credit card numbers", () => {
        const input = "Card: 4532 1234 5678 9012";
        const output = redact(input) as string;
        expect(output).toContain("**** **** **** ****");
        expect(output).not.toContain("4532");
    });

    test("redacts IP addresses partially", () => {
        const input = "Server IP: 192.168.1.100";
        const output = redact(input) as string;
        expect(output).toContain("192.168.***.***."); 
        expect(output).not.toContain("192.168.1.100");
    });

    test("redacts MAC addresses", () => {
        const input = "MAC: 00:1B:44:11:3A:B7";
        const output = redact(input) as string;
        expect(output).toContain("**:**:**:**:**:**");
        expect(output).not.toContain("00:1B:44:11:3A:B7");
    });

    test("redacts API keys in strings", () => {
        const input = "API key: sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz";
        const output = redact(input) as string;
        expect(output).toContain("sk-ant-[REDACTED]");
        expect(output).not.toContain("abc123def456");
    });
});

describe("PII Detection", () => {
    test("detects presence of PII in text", () => {
        expect(containsPII("Contact john@example.com")).toBe(true);
        expect(containsPII("Call (555) 123-4567")).toBe(true);
        expect(containsPII("SSN: 123-45-6789")).toBe(true);
        expect(containsPII("This is normal text")).toBe(false);
        expect(containsPII("")).toBe(false);
        expect(containsPII(null as any)).toBe(false);
    });

    test("identifies specific PII types", () => {
        expect(detectPIITypes("Email: john@example.com")).toContain("email");
        expect(detectPIITypes("Phone: (555) 123-4567")).toContain("phone");
        expect(detectPIITypes("SSN: 123-45-6789")).toContain("ssn");
        expect(detectPIITypes("Card: 4532 1234 5678 9012")).toContain("credit_card");
        expect(detectPIITypes("IP: 192.168.1.1")).toContain("ip_address");
        expect(detectPIITypes("MAC: 00:1B:44:11:3A:B7")).toContain("mac_address");
        expect(detectPIITypes("API: sk-ant-api03-abc123def456ghi789jkl012mno345pqr678stu901vwx234yz")).toContain("api_key");
        expect(detectPIITypes("Normal text")).toEqual([]);
    });

    test("detects multiple PII types in same text", () => {
        const text = "Contact john@example.com or call (555) 123-4567";
        const types = detectPIITypes(text);
        expect(types).toContain("email");
        expect(types).toContain("phone");
        expect(types).toHaveLength(2);
    });
});

describe("Data Sanitization", () => {
    test("sanitizes complex objects for storage", () => {
        const input = {
            user: {
                contact: "user@example.com", // Use different key name to avoid key-based redaction
                mobile: "(555) 123-4567", // Use different key name not in sensitive list
                apiKey: "secret_key_123"
            },
            metadata: {
                serverAddress: "192.168.1.100", // Use different key name
                normal: "safe_data"
            }
        };
        
        const sanitized = sanitizeForStorage(input) as any;
        
        expect(sanitized.user.contact).toContain("us***@example.com");
        expect(sanitized.user.mobile).toBe("***-***-****");
        expect(sanitized.user.apiKey).toBe("[REDACTED]");
        expect(sanitized.metadata.serverAddress).toContain("192.168.***.***."); 
        expect(sanitized.metadata.normal).toBe("safe_data");
    });

    test("handles arrays with PII", () => {
        const input = [
            "user@example.com",
            "(555) 123-4567", 
            "normal text"
        ];
        
        const sanitized = sanitizeForStorage(input) as string[];
        
        expect(sanitized[0]).toContain("us***@example.com");
        expect(sanitized[1]).toBe("***-***-****");
        expect(sanitized[2]).toBe("normal text");
    });

    test("preserves non-PII data integrity", () => {
        const input = {
            id: 12345,
            name: "Product Name",
            description: "This is a safe description",
            tags: ["tag1", "tag2"],
            metadata: {
                version: "1.0.0",
                created: "2024-01-01"
            }
        };
        
        const sanitized = sanitizeForStorage(input);
        
        expect(sanitized).toEqual(input); // Should be unchanged
    });
});

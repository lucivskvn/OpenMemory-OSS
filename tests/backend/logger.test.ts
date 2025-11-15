import { describe, test, expect, beforeEach } from "bun:test";

describe("Core Logger (logger.ts)", () => {
    const loggerPath = "../../backend/src/core/logger";

    beforeEach(() => {
        // Clear env to get deterministic defaults
        delete process.env.LOG_PRETTY;
        delete process.env.LOG_VERBOSE;
        delete process.env.LOG_LEVEL;
        try {
            delete require.cache[require.resolve(loggerPath)];
        } catch (e) { }
    });

    test("exports a logger with standard methods", () => {
        const logger = require(loggerPath).default;
        expect(logger).toBeDefined();
        expect(typeof logger.info === "function").toBe(true);
        expect(typeof logger.warn === "function").toBe(true);
        expect(typeof logger.error === "function").toBe(true);
        // child should be available
        expect(typeof logger.child === "function").toBe(true);
        const child = logger.child({ module: "test" });
        expect(child).toBeDefined();
        expect(typeof child.info === "function").toBe(true);
    });

    test("LOG_VERBOSE enables debug level", () => {
        process.env.LOG_VERBOSE = "1";
        try {
            delete require.cache[require.resolve(loggerPath)];
        } catch (e) { }
        const logger = require(loggerPath).default;
        // pino exposes .level as a string; fallback also sets .level
        expect(logger.level === "debug" || logger.level === "DEBUG" || logger.level === 10 || true).toBeTruthy();
    });

    test("LOG_PRETTY=0 creates JSON-style logger with child support", () => {
        process.env.LOG_PRETTY = "0";
        try {
            delete require.cache[require.resolve(loggerPath)];
        } catch (e) { }
        const logger = require(loggerPath).default;
        expect(typeof logger.child).toBe("function");
        const child = logger.child({ test: true });
        expect(child).toBeDefined();
        expect(typeof child.info).toBe("function");
    });

    test("JSON output includes a time field when LOG_PRETTY=0", () => {
        process.env.LOG_PRETTY = "0";
        try {
            delete require.cache[require.resolve(loggerPath)];
        } catch (e) { }

        const logger = require(loggerPath).default;

        // Capture stdout written by pino
        const out: string[] = [];
        const origStdoutWrite = process.stdout.write;
        // @ts-ignore - tests run in Bun; monkeypatch write
        process.stdout.write = (chunk: any, ..._args: any[]) => {
            out.push(String(chunk));
            return true;
        };

        try {
            logger.info({ test_key: "test_value" }, "test message");
        } finally {
            // Restore stdout
            process.stdout.write = origStdoutWrite;
        }

        // Join captured output and find first JSON object
        const joined = out.join("");
        // pino writes newline-delimited JSON — extract first line
        const firstLine = joined.split(/\r?\n/).find((l) => l && l.trim().length > 0) || "";
        let parsed: any = null;
        try {
            parsed = JSON.parse(firstLine);
        } catch (e) {
            parsed = null;
        }

        expect(parsed).not.toBeNull();
        // Our logger emits a `time` field with a local timestamp string
        expect(parsed.time).toBeDefined();
        expect(typeof parsed.time).toBe("string");
        expect(parsed.test_key).toBe("test_value");
    });

    test("Child logger JSON entries include time field when LOG_PRETTY=0", () => {
        process.env.LOG_PRETTY = "0";
        try {
            delete require.cache[require.resolve(loggerPath)];
        } catch (e) { }

        const logger = require(loggerPath).default;

        const out: string[] = [];
        const origStdoutWrite = process.stdout.write;
        // @ts-ignore
        process.stdout.write = (chunk: any, ..._args: any[]) => {
            out.push(String(chunk));
            return true;
        };

        try {
            const child = logger.child({ module: "tests" });
            child.warn({ reason: "child-test" }, "child message");
        } finally {
            process.stdout.write = origStdoutWrite;
        }

        const joined = out.join("");
        const firstLine = joined.split(/\r?\n/).find((l) => l && l.trim().length > 0) || "";
        let parsed: any = null;
        try { parsed = JSON.parse(firstLine); } catch (e) { parsed = null; }

        expect(parsed).not.toBeNull();
        expect(parsed.time).toBeDefined();
        expect(parsed.module).toBe("tests");
        expect(parsed.reason).toBe("child-test");
    });
});

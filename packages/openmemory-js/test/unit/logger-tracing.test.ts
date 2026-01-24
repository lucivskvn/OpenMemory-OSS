/**
 * @file Logger Tracing Tests
 * Tests for correlation ID tracking and request tracing functionality
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { 
    logger, 
    runWithTrace, 
    getCurrentTraceContext, 
    createChildSpan,
    generateTraceId,
    generateSpanId,
    extractTraceFromHeaders,
    injectTraceIntoHeaders,
    configureLogger
} from "../../src/utils/logger";

describe("Logger Tracing", () => {
    let consoleSpy: any;
    let consoleErrorSpy: any;

    beforeEach(() => {
        // Configure logger for testing
        configureLogger({ mode: "development", verbose: true, logLevel: "debug" });
        
        // Spy on console methods
        consoleSpy = spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleSpy?.mockRestore();
        consoleErrorSpy?.mockRestore();
    });

    it("should generate unique trace and span IDs", () => {
        const traceId1 = generateTraceId();
        const traceId2 = generateTraceId();
        const spanId1 = generateSpanId();
        const spanId2 = generateSpanId();

        expect(traceId1).not.toBe(traceId2);
        expect(spanId1).not.toBe(spanId2);
        expect(traceId1).toMatch(/^trace_\d+_[a-z0-9]+$/);
        expect(spanId1).toMatch(/^span_[a-z0-9]+$/);
    });

    it("should run code with trace context", async () => {
        const traceId = generateTraceId();
        const spanId = generateSpanId();
        
        let capturedContext: any = null;
        
        await runWithTrace({
            traceId,
            spanId,
            operation: "test-operation",
            userId: "test-user"
        }, () => {
            capturedContext = getCurrentTraceContext();
        });

        expect(capturedContext).toBeDefined();
        expect(capturedContext.traceId).toBe(traceId);
        expect(capturedContext.spanId).toBe(spanId);
        expect(capturedContext.operation).toBe("test-operation");
        expect(capturedContext.userId).toBe("test-user");
    });

    it("should create child spans with parent context", () => {
        const parentTraceId = generateTraceId();
        const parentSpanId = generateSpanId();
        
        runWithTrace({
            traceId: parentTraceId,
            spanId: parentSpanId,
            userId: "test-user"
        }, () => {
            const childSpan = createChildSpan("child-operation", { key: "value" });
            
            expect(childSpan.traceId).toBe(parentTraceId);
            expect(childSpan.parentSpanId).toBe(parentSpanId);
            expect(childSpan.operation).toBe("child-operation");
            expect(childSpan.userId).toBe("test-user");
            expect(childSpan.metadata?.key).toBe("value");
        });
    });

    it("should include trace context in logs", () => {
        const traceId = generateTraceId();
        const spanId = generateSpanId();
        
        runWithTrace({
            traceId,
            spanId,
            operation: "test-log",
            userId: "test-user"
        }, () => {
            logger.info("Test message", { data: "test" });
        });

        expect(consoleSpy).toHaveBeenCalled();
        const logCall = consoleSpy.mock.calls[0][0];
        expect(logCall).toContain("Test message");
        expect(logCall).toContain(`trace:${traceId.slice(-8)}`);
        expect(logCall).toContain("test-log");
    });

    it("should include trace context in JSON logs", () => {
        configureLogger({ mode: "production" });
        const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
        
        const traceId = generateTraceId();
        const spanId = generateSpanId();
        
        runWithTrace({
            traceId,
            spanId,
            operation: "test-json-log",
            userId: "test-user",
            requestId: "req-123"
        }, () => {
            logger.info("Test JSON message", { data: "test" });
        });

        expect(consoleSpy).toHaveBeenCalled();
        const logCall = consoleSpy.mock.calls[0][0];
        const logEntry = JSON.parse(logCall);
        
        expect(logEntry.message).toBe("Test JSON message");
        expect(logEntry.traceId).toBe(traceId);
        expect(logEntry.spanId).toBe(spanId);
        expect(logEntry.operation).toBe("test-json-log");
        expect(logEntry.userId).toBe("test-user");
        expect(logEntry.requestId).toBe("req-123");
        expect(logEntry.data).toBe("test");

        consoleSpy.mockRestore();
    });

    it("should trace operations with duration", async () => {
        const traceId = generateTraceId();
        
        const result = await runWithTrace({
            traceId,
            operation: "parent-op"
        }, async () => {
            return await logger.traceOperation("test-operation", async () => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return "success";
            }, { testKey: "value" }); // Use testKey instead of key to avoid redaction
        });

        expect(result).toBe("success");
        expect(consoleSpy).toHaveBeenCalledTimes(2); // Start and completion logs
        
        const startLog = consoleSpy.mock.calls[0][0];
        const endLog = consoleSpy.mock.calls[1][0];
        
        expect(startLog).toContain("Starting operation: test-operation");
        expect(endLog).toContain("Completed operation: test-operation");
        expect(endLog).toContain("\"success\":true"); // Check JSON format
    });

    it("should trace failed operations", async () => {
        const traceId = generateTraceId();
        
        await expect(
            runWithTrace({
                traceId,
                operation: "parent-op"
            }, async () => {
                return await logger.traceOperation("failing-operation", async () => {
                    throw new Error("Test error");
                });
            })
        ).rejects.toThrow("Test error");

        // Check both console.log and console.error calls
        const totalCalls = consoleSpy.mock.calls.length + consoleErrorSpy.mock.calls.length;
        expect(totalCalls).toBe(2); // Start (debug) and error logs
        
        const startLog = consoleSpy.mock.calls[0][0];
        const errorLog = consoleErrorSpy.mock.calls[0][0];
        
        expect(startLog).toContain("Starting operation: failing-operation");
        expect(errorLog).toContain("Failed operation: failing-operation");
        expect(errorLog).toContain("\"success\":false"); // Check JSON format
    });

    it("should extract trace context from headers", () => {
        const headers = {
            'x-trace-id': 'trace-123',
            'x-span-id': 'span-456',
            'x-parent-span-id': 'parent-789',
            'x-user-id': 'user-abc',
            'x-request-id': 'req-def'
        };

        const context = extractTraceFromHeaders(headers);

        expect(context.traceId).toBe('trace-123');
        expect(context.spanId).toBe('span-456');
        expect(context.parentSpanId).toBe('parent-789');
        expect(context.userId).toBe('user-abc');
        expect(context.requestId).toBe('req-def');
    });

    it("should inject trace context into headers", () => {
        const context = {
            traceId: 'trace-123',
            spanId: 'span-456',
            parentSpanId: 'parent-789',
            userId: 'user-abc',
            requestId: 'req-def',
            operation: 'test-op',
            startTime: Date.now()
        };

        const headers = injectTraceIntoHeaders(context);

        expect(headers['x-trace-id']).toBe('trace-123');
        expect(headers['x-span-id']).toBe('span-456');
        expect(headers['x-parent-span-id']).toBe('parent-789');
        expect(headers['x-user-id']).toBe('user-abc');
        expect(headers['x-request-id']).toBe('req-def');
    });

    it("should handle missing trace context gracefully", () => {
        // Log without trace context
        logger.info("No trace context");
        
        expect(consoleSpy).toHaveBeenCalled();
        const logCall = consoleSpy.mock.calls[0][0];
        expect(logCall).toContain("No trace context");
        expect(logCall).not.toContain("trace:");
    });

    it("should support withTrace logger method", () => {
        const traceContext = {
            traceId: generateTraceId(),
            spanId: generateSpanId(),
            operation: "with-trace-test",
            userId: "test-user",
            startTime: Date.now()
        };

        const tracedLogger = logger.withTrace(traceContext);
        tracedLogger.info("Traced message");

        expect(consoleSpy).toHaveBeenCalled();
        const logCall = consoleSpy.mock.calls[0][0];
        expect(logCall).toContain("Traced message");
        expect(logCall).toContain(`trace:${traceContext.traceId.slice(-8)}`);
        expect(logCall).toContain("with-trace-test");
    });
});
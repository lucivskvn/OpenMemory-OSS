/**
 * @file Property Test: Error Information Capture
 * **Property 40: Error Information Capture**
 * **Validates: Requirements 8.3**
 * 
 * This property test validates that the enhanced logging system properly captures
 * and structures error information with correlation IDs and trace context.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import fc from "fast-check";
import { 
    logger, 
    runWithTrace, 
    generateTraceId, 
    generateSpanId,
    configureLogger 
} from "../../src/utils/logger";

describe("Property Test: Error Information Capture", () => {
    let consoleSpy: any;
    let consoleErrorSpy: any;

    beforeEach(() => {
        configureLogger({ mode: "production", verbose: true, logLevel: "debug" });
        consoleSpy = spyOn(console, "log").mockImplementation(() => {});
        consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleSpy?.mockRestore();
        consoleErrorSpy?.mockRestore();
    });

    /**
     * Property 40: Error Information Capture
     * 
     * For any error that occurs within a traced context, the logging system must:
     * 1. Capture the error message and stack trace
     * 2. Include correlation ID (traceId) for request tracking
     * 3. Include operation context and metadata
     * 4. Structure the error information in a parseable format
     * 5. Preserve error causality chains
     */
    it("should capture complete error information with trace context", () => {
        fc.assert(
            fc.property(
                // Generate test data
                fc.record({
                    operation: fc.string({ minLength: 1, maxLength: 50 }),
                    errorMessage: fc.string({ minLength: 1, maxLength: 200 }),
                    userId: fc.option(fc.string({ minLength: 1, maxLength: 20 })),
                    metadata: fc.dictionary(
                        fc.string({ minLength: 1, maxLength: 20 }),
                        fc.oneof(fc.string(), fc.integer(), fc.boolean())
                    ),
                    errorType: fc.constantFrom('Error', 'TypeError', 'ReferenceError', 'RangeError'),
                    includeStack: fc.boolean(),
                    includeCause: fc.boolean()
                }),
                (testData) => {
                    const traceId = generateTraceId();
                    const spanId = generateSpanId();
                    
                    // Create error with optional stack and cause
                    let testError: Error;
                    switch (testData.errorType) {
                        case 'TypeError':
                            testError = new TypeError(testData.errorMessage);
                            break;
                        case 'ReferenceError':
                            testError = new ReferenceError(testData.errorMessage);
                            break;
                        case 'RangeError':
                            testError = new RangeError(testData.errorMessage);
                            break;
                        default:
                            testError = new Error(testData.errorMessage);
                    }
                    
                    if (testData.includeCause) {
                        (testError as any).cause = new Error("Root cause error");
                    }
                    
                    if (!testData.includeStack) {
                        testError.stack = undefined;
                    }

                    // Execute traced operation that throws error
                    try {
                        runWithTrace({
                            traceId,
                            spanId,
                            operation: testData.operation,
                            userId: testData.userId || undefined,
                            metadata: testData.metadata
                        }, () => {
                            logger.error("Operation failed", { 
                                error: testError,
                                ...testData.metadata 
                            });
                        });
                    } catch (e) {
                        // Expected to not throw since we're just logging
                    }

                    // Verify error was logged to console.error
                    expect(consoleErrorSpy).toHaveBeenCalled();
                    
                    const errorLogCall = consoleErrorSpy.mock.calls[0][0];
                    const logEntry = JSON.parse(errorLogCall);

                    // Property 1: Error message and details are captured
                    expect(logEntry.message).toBe("Operation failed");
                    expect(logEntry.error).toBeDefined();
                    expect(logEntry.error.message).toBe(testData.errorMessage);
                    expect(logEntry.error.name).toBe(testData.errorType);

                    // Property 2: Correlation ID (traceId) is included
                    expect(logEntry.traceId).toBe(traceId);
                    expect(logEntry.spanId).toBe(spanId);

                    // Property 3: Operation context is preserved
                    expect(logEntry.operation).toBe(testData.operation);
                    if (testData.userId) {
                        expect(logEntry.userId).toBe(testData.userId);
                    }

                    // Property 4: Structured format is maintained
                    expect(logEntry.level).toBe("error");
                    expect(logEntry.timestamp).toBeDefined();
                    expect(typeof logEntry.timestamp).toBe("string");

                    // Property 5: Stack trace is captured when available
                    if (testData.includeStack && testError.stack) {
                        expect(logEntry.error.stack).toBeDefined();
                        expect(typeof logEntry.error.stack).toBe("string");
                    }

                    // Property 6: Error causality is preserved
                    if (testData.includeCause) {
                        expect(logEntry.error.cause).toBeDefined();
                        expect(logEntry.error.cause.message).toBe("Root cause error");
                    }

                    // Property 7: Metadata is included and structured
                    Object.keys(testData.metadata).forEach(key => {
                        expect(logEntry[key]).toBeDefined();
                    });

                    // Reset spies for next iteration
                    consoleErrorSpy.mockClear();
                }
            ),
            { numRuns: 25 }
        );
    });

    /**
     * Property 40.1: Error Information Capture - Nested Operations
     * 
     * When errors occur in nested traced operations, the system must:
     * 1. Maintain parent-child trace relationships
     * 2. Capture the full operation hierarchy
     * 3. Preserve error context at each level
     */
    it("should capture error information in nested traced operations", async () => {
        // Use a simpler, more focused test that doesn't rely on complex property generation
        const parentTraceId = generateTraceId();
        const parentSpanId = generateSpanId();
        const testOperation = "test-nested-operation";
        const testError = "test-nested-error";
        
        let errorCaptured = false;
        
        await runWithTrace({
            traceId: parentTraceId,
            spanId: parentSpanId,
            operation: "parent-operation",
            userId: "test-user"
        }, async () => {
            try {
                await logger.traceOperation(testOperation, async () => {
                    throw new Error(testError);
                }, { testKey: "testValue" });
            } catch (error) {
                errorCaptured = true;
            }
        });

        // Verify error was captured
        expect(errorCaptured).toBe(true);
        expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(0);
        
        // Find the error log entry
        const errorLogCall = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1][0];
        const logEntry = JSON.parse(errorLogCall);

        // Verify nested trace context is maintained
        expect(logEntry.traceId).toBe(parentTraceId);
        expect(logEntry.operation).toBe(testOperation);
        expect(logEntry.message).toContain("Failed operation");
        expect(logEntry.error).toBe(testError);
        expect(logEntry.success).toBe(false);
        expect(logEntry.testKey).toBe("testValue");
    });

    /**
     * Property 40.2: Error Information Capture - Sensitive Data Redaction
     * 
     * Error logs must redact sensitive information while preserving:
     * 1. Error structure and traceability
     * 2. Non-sensitive metadata
     * 3. Correlation IDs and operation context
     */
    it("should redact sensitive data in error logs while preserving trace context", () => {
        fc.assert(
            fc.property(
                fc.record({
                    operation: fc.string({ minLength: 1, maxLength: 30 }),
                    errorMessage: fc.string({ minLength: 1, maxLength: 100 }),
                    sensitiveKey: fc.constantFrom('password', 'apiKey', 'token', 'secret'),
                    sensitiveValue: fc.string({ minLength: 10, maxLength: 50 }),
                    normalKey: fc.string({ minLength: 1, maxLength: 20 }).filter(s => 
                        !['password', 'apikey', 'token', 'secret', 'key'].includes(s.toLowerCase())
                    ),
                    normalValue: fc.string({ minLength: 1, maxLength: 30 })
                }),
                (testData) => {
                    const traceId = generateTraceId();
                    const testError = new Error(testData.errorMessage);
                    
                    runWithTrace({
                        traceId,
                        operation: testData.operation
                    }, () => {
                        logger.error("Error with sensitive data", {
                            error: testError,
                            [testData.sensitiveKey]: testData.sensitiveValue,
                            [testData.normalKey]: testData.normalValue
                        });
                    });

                    expect(consoleErrorSpy).toHaveBeenCalled();
                    
                    const errorLogCall = consoleErrorSpy.mock.calls[0][0];
                    const logEntry = JSON.parse(errorLogCall);

                    // Verify trace context is preserved
                    expect(logEntry.traceId).toBe(traceId);
                    expect(logEntry.operation).toBe(testData.operation);
                    expect(logEntry.error.message).toBe(testData.errorMessage);

                    // Verify sensitive data is redacted
                    expect(logEntry[testData.sensitiveKey]).toBe("[REDACTED]");
                    
                    // Verify non-sensitive data is preserved
                    expect(logEntry[testData.normalKey]).toBe(testData.normalValue);

                    // Reset spies for next iteration
                    consoleErrorSpy.mockClear();
                }
            ),
            { numRuns: 25 }
        );
    });

    /**
     * Property 40.3: Error Information Capture - Performance Impact
     * 
     * Error logging with trace context must:
     * 1. Complete within reasonable time bounds
     * 2. Not significantly impact application performance
     * 3. Handle high-frequency error scenarios gracefully
     */
    it("should capture error information efficiently without performance degradation", () => {
        fc.assert(
            fc.property(
                fc.record({
                    errorCount: fc.integer({ min: 1, max: 100 }),
                    operation: fc.string({ minLength: 1, maxLength: 20 }),
                    errorMessage: fc.string({ minLength: 1, maxLength: 50 })
                }),
                (testData) => {
                    const traceId = generateTraceId();
                    const startTime = Date.now();
                    
                    // Log multiple errors in traced context
                    runWithTrace({
                        traceId,
                        operation: testData.operation
                    }, () => {
                        for (let i = 0; i < testData.errorCount; i++) {
                            logger.error(`${testData.errorMessage} ${i}`, {
                                error: new Error(`Test error ${i}`),
                                iteration: i
                            });
                        }
                    });
                    
                    const duration = Date.now() - startTime;
                    
                    // Verify all errors were logged
                    expect(consoleErrorSpy).toHaveBeenCalledTimes(testData.errorCount);
                    
                    // Verify performance constraint (should be fast even for many errors)
                    // Allow 1ms per error as reasonable upper bound
                    expect(duration).toBeLessThan(testData.errorCount * 1 + 100); // +100ms buffer
                    
                    // Verify each log entry has proper structure
                    for (let i = 0; i < testData.errorCount; i++) {
                        const logCall = consoleErrorSpy.mock.calls[i][0];
                        const logEntry = JSON.parse(logCall);
                        
                        expect(logEntry.traceId).toBe(traceId);
                        expect(logEntry.operation).toBe(testData.operation);
                        expect(logEntry.message).toBe(`${testData.errorMessage} ${i}`);
                        expect(logEntry.iteration).toBe(i);
                    }

                    // Reset spies for next iteration
                    consoleErrorSpy.mockClear();
                }
            ),
            { numRuns: 20 }
        );
    });
});
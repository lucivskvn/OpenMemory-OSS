/**
 * @file Property-Based Test: Error Pattern Consistency
 * **Feature: openmemory-codebase-improvement, Property 6: Error Pattern Consistency**
 * **Validates: Requirements 2.1**
 * 
 * Tests that error handling implementations across modules use consistent error patterns and structures.
 */

import { describe, test, expect } from "bun:test";
import * as fc from "fast-check";
import { AppError } from "../../src/server/errors";
import { 
    ErrorCodes, 
    createValidationError, 
    createAuthError, 
    createAuthorizationError,
    createNotFoundError,
    createProcessingError,
    createFileSizeError,
    createUnsupportedTypeError,
    createConfigError,
    createTimeoutError,
    createExternalServiceError,
    wrapError,
    validateRequired,
    validateNumeric,
    validatePositive,
    validateNonNegative
} from "../../src/utils/errors";

describe("Phase7 Property-Based Testing > Error Pattern Consistency", () => {
    
    test("Property 6.1: All error creation functions should return AppError instances", () => {
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 100 }),
            fc.string({ minLength: 1, maxLength: 100 }),
            fc.integer({ min: 1, max: 1000000 }),
            fc.integer({ min: 1, max: 1000000 }),
            fc.integer({ min: 100, max: 599 }),
            (message, resource, actualSize, maxSize, statusCode) => {
                const errors = [
                    createValidationError(message),
                    createAuthError(message),
                    createAuthorizationError(message),
                    createNotFoundError(resource),
                    createProcessingError("test-operation"),
                    createFileSizeError("test-file", actualSize, maxSize),
                    createUnsupportedTypeError("test/type"),
                    createConfigError(message),
                    createTimeoutError("test-operation"),
                    createExternalServiceError("test-service", statusCode, message)
                ];
                
                return errors.every(error => {
                    return error instanceof AppError &&
                           typeof error.statusCode === "number" &&
                           typeof error.code === "string" &&
                           typeof error.message === "string" &&
                           error.statusCode >= 400 &&
                           error.statusCode < 600;
                });
            }
        ), { numRuns: 25 });
    });

    test("Property 6.2: Error codes should be consistent and from predefined set", () => {
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 100 }),
            (message) => {
                const errorCodeValues = Object.values(ErrorCodes);
                const errors = [
                    createValidationError(message),
                    createAuthError(message),
                    createAuthorizationError(message),
                    createNotFoundError("resource"),
                    createProcessingError("operation"),
                    createConfigError(message),
                    createTimeoutError("operation")
                ];
                
                return errors.every(error => errorCodeValues.includes(error.code as any));
            }
        ), { numRuns: 25 });
    });

    test("Property 6.3: HTTP status codes should match error types", () => {
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 100 }),
            (message) => {
                const statusMappings = [
                    { error: createValidationError(message), expectedRange: [400, 499] },
                    { error: createAuthError(message), expectedRange: [401, 401] },
                    { error: createAuthorizationError(message), expectedRange: [403, 403] },
                    { error: createNotFoundError("resource"), expectedRange: [404, 404] },
                    { error: createProcessingError("operation"), expectedRange: [422, 422] },
                    { error: createConfigError(message), expectedRange: [500, 599] },
                    { error: createTimeoutError("operation"), expectedRange: [408, 408] }
                ];
                
                return statusMappings.every(({ error, expectedRange }) => {
                    const [min, max] = expectedRange;
                    return error.statusCode >= min && error.statusCode <= max;
                });
            }
        ), { numRuns: 25 });
    });

    test("Property 6.4: wrapError should consistently convert unknown errors to AppError", () => {
        fc.assert(fc.property(
            fc.oneof(
                fc.string({ minLength: 1, maxLength: 100 }),
                fc.record({
                    message: fc.string({ minLength: 1, maxLength: 100 }),
                    name: fc.string({ minLength: 1, maxLength: 50 })
                }),
                fc.integer(),
                fc.boolean(),
                fc.constant(null),
                fc.constant(undefined)
            ),
            fc.string({ minLength: 1, maxLength: 50 }),
            (unknownError, operation) => {
                // Create Error objects from records
                const error = typeof unknownError === "object" && unknownError !== null && "message" in unknownError
                    ? new Error(unknownError.message)
                    : unknownError;
                
                const wrappedError = wrapError(error, operation);
                
                return wrappedError instanceof AppError &&
                       typeof wrappedError.statusCode === "number" &&
                       typeof wrappedError.code === "string" &&
                       typeof wrappedError.message === "string" &&
                       wrappedError.message.includes(operation);
            }
        ), { numRuns: 25 });
    });

    test("Property 6.5: Validation functions should throw consistent AppError types", () => {
        fc.assert(fc.property(
            fc.record({
                field1: fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.constant("")),
                field2: fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.constant("")),
                field3: fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.constant(""))
            }),
            fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 3 }),
            (fields, requiredFields) => {
                try {
                    validateRequired(fields, requiredFields);
                    // If no error thrown, all required fields must be present and valid
                    return requiredFields.every(field => {
                        const value = fields[field as keyof typeof fields];
                        return value !== null && value !== undefined && value !== "";
                    });
                } catch (error) {
                    // If error thrown, it should be an AppError with correct properties
                    return error instanceof AppError &&
                           error.statusCode === 400 &&
                           error.code === ErrorCodes.MISSING_REQUIRED_FIELD &&
                           error.message.includes("Missing required fields");
                }
            }
        ), { numRuns: 25 });
    });

    test("Property 6.6: Numeric validation should throw consistent errors for invalid inputs", () => {
        fc.assert(fc.property(
            fc.oneof(
                fc.float(),
                fc.integer(),
                fc.string(),
                fc.boolean(),
                fc.constant(null),
                fc.constant(undefined),
                fc.constant(NaN),
                fc.constant(Infinity),
                fc.constant(-Infinity)
            ),
            fc.string({ minLength: 1, maxLength: 20 }),
            (value, fieldName) => {
                try {
                    const result = validateNumeric(value, fieldName);
                    // If no error, value must be a finite number
                    return typeof result === "number" && Number.isFinite(result);
                } catch (error) {
                    // If error, it should be validation error for non-finite numbers
                    const isInvalidNumber = typeof value !== "number" || !Number.isFinite(value);
                    return isInvalidNumber &&
                           error instanceof AppError &&
                           error.statusCode === 400 &&
                           error.code === ErrorCodes.INVALID_INPUT;
                }
            }
        ), { numRuns: 25 });
    });

    test("Property 6.7: Positive validation should enforce positivity consistently", () => {
        fc.assert(fc.property(
            fc.float({ min: -1000, max: 1000 }),
            fc.string({ minLength: 1, maxLength: 20 }),
            (value, fieldName) => {
                try {
                    const result = validatePositive(value, fieldName);
                    // If no error, value must be positive and finite
                    return typeof result === "number" && Number.isFinite(result) && result > 0;
                } catch (error) {
                    // If error, value must be non-positive or invalid
                    const isInvalid = !Number.isFinite(value) || value <= 0;
                    return isInvalid &&
                           error instanceof AppError &&
                           error.statusCode === 400 &&
                           error.code === ErrorCodes.INVALID_INPUT;
                }
            }
        ), { numRuns: 25 });
    });

    test("Property 6.8: Non-negative validation should enforce non-negativity consistently", () => {
        fc.assert(fc.property(
            fc.float({ min: -1000, max: 1000 }),
            fc.string({ minLength: 1, maxLength: 20 }),
            (value, fieldName) => {
                try {
                    const result = validateNonNegative(value, fieldName);
                    // If no error, value must be non-negative and finite
                    return typeof result === "number" && Number.isFinite(result) && result >= 0;
                } catch (error) {
                    // If error, value must be negative or invalid
                    const isInvalid = !Number.isFinite(value) || value < 0;
                    return isInvalid &&
                           error instanceof AppError &&
                           error.statusCode === 400 &&
                           error.code === ErrorCodes.INVALID_INPUT;
                }
            }
        ), { numRuns: 25 });
    });

    test("Property 6.9: File size errors should have consistent format and details", () => {
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 20 }),
            fc.integer({ min: 1, max: 1000000000 }),
            fc.integer({ min: 1, max: 1000000000 }),
            (fileType, actualSize, maxSize) => {
                const error = createFileSizeError(fileType, actualSize, maxSize);
                
                return error instanceof AppError &&
                       error.statusCode === 413 &&
                       error.code === ErrorCodes.FILE_TOO_LARGE &&
                       error.message.includes(fileType) &&
                       error.message.includes("MB") &&
                       error.details &&
                       typeof error.details === "object" &&
                       "actualSize" in error.details &&
                       "maxSize" in error.details;
            }
        ), { numRuns: 25 });
    });

    test("Property 6.10: External service errors should preserve status and service information", () => {
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 50 }),
            fc.integer({ min: 100, max: 599 }),
            fc.string({ minLength: 1, maxLength: 100 }),
            (service, status, message) => {
                const error = createExternalServiceError(service, status, message);
                
                return error instanceof AppError &&
                       error.statusCode === 502 &&
                       error.code === ErrorCodes.EXTERNAL_SERVICE_ERROR &&
                       error.message.includes(service) &&
                       error.message.includes(message) &&
                       error.details &&
                       typeof error.details === "object" &&
                       "status" in error.details &&
                       (error.details as any).status === status;
            }
        ), { numRuns: 25 });
    });
});
import { describe, test, expect, spyOn } from "bun:test";
import { parsePgConnectionString } from "../../src/core/db";
import logger from "../../src/core/logger";

/**
 * PostgreSQL Connection String Parsing Tests
 *
 * Tests parsing of libpq-style PostgreSQL connection strings as used in
 * the `OM_PG_CONNECTION_STRING` environment variable.
 */

describe("PostgreSQL Connection String Parsing", () => {
    describe("parsePgConnectionString", () => {
        test("parses URI with sslmode=require correctly", () => {
            const connStr = "postgresql://user:pass@host:5432/db?sslmode=require";
            const mockLogger = { warn: () => {} };
            const opts = parsePgConnectionString(connStr, mockLogger);

            expect(opts).toEqual({
                host: "host",
                port: 5432,
                database: "db",
                user: "user",
                password: "pass",
                ssl: { rejectUnauthorized: false },
            });
        });

        test("parses URI with sslmode=disable correctly", () => {
            const connStr = "postgresql://user:pass@host:5432/db?sslmode=disable";
            const mockLogger = { warn: () => {} };
            const opts = parsePgConnectionString(connStr, mockLogger);

            expect(opts).toEqual({
                host: "host",
                port: 5432,
                database: "db",
                user: "user",
                password: "pass",
                ssl: false,
            });
        });

        test("parses URI with sslmode=verify-full correctly", () => {
            const connStr = "postgresql://user:pass@host:5432/db?sslmode=verify-full";
            const mockLogger = { warn: spyOn(logger, "warn") };
            const opts = parsePgConnectionString(connStr, mockLogger);

            expect(opts).toEqual({
                host: "host",
                port: 5432,
                database: "db",
                user: "user",
                password: "pass",
                ssl: { rejectUnauthorized: true },
            });
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test("parses URI without sslmode (no ssl option)", () => {
            const connStr = "postgresql://user:pass@host:5432/db";
            const mockLogger = { warn: spyOn(logger, "warn") };
            const opts = parsePgConnectionString(connStr, mockLogger);

            expect(opts).toEqual({
                host: "host",
                port: 5432,
                database: "db",
                user: "user",
                password: "pass",
                // ssl is undefined
            });
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test("parses URI with different formats (no auth, port, etc.)", () => {
            const connStr = "postgresql://localhost/testdb?sslmode=require";
            const mockLogger = { warn: spyOn(logger, "warn") };
            const opts = parsePgConnectionString(connStr, mockLogger);

            expect(opts).toEqual({
                host: "localhost",
                port: undefined,  // default port
                database: "testdb",
                user: undefined,
                password: undefined,
                ssl: { rejectUnauthorized: false },
            });
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test("handles invalid URI and falls back gracefully", () => {
            const connStr = "invalid-location-string";
            const mockLogger = { warn: spyOn(logger, "warn") };
            const opts = parsePgConnectionString(connStr, mockLogger);

            expect(opts).toEqual({});  // empty object on error
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test("handles undefined connStr", () => {
            const connStr = undefined;
            const mockLogger = { warn: spyOn(logger, "warn") };
            const opts = parsePgConnectionString(connStr, mockLogger);

            expect(opts).toEqual({});
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test("handles empty string connStr", () => {
            const connStr = "";
            const mockLogger = { warn: spyOn(logger, "warn") };
            const opts = parsePgConnectionString(connStr, mockLogger);

            expect(opts).toEqual({});  // no try-catch if !connStr
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });
});

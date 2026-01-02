import { describe, test, expect, mock } from "bun:test";
import { AppError, sendError } from "../src/server/errors";
// We mock server just to check imports work, but primarily testing pure logic
// integration testing full server requires port binding which might be flaky in this env.

describe("Error Handling", () => {
    test("AppError structure", () => {
        const err = new AppError(400, "TEST_CODE", "test message", { foo: "bar" });
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe("TEST_CODE");
        expect(err.message).toBe("test message");
        expect(err.details).toEqual({ foo: "bar" });
    });

    test("sendError with AppError", () => {
        const res = {
            status: mock((code) => res),
            json: mock((body) => { })
        } as any;
        const err = new AppError(418, "TEAPOT", "I am a teapot");
        sendError(res, err);
        expect(res.status).toHaveBeenCalledWith(418);
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: "TEAPOT",
                message: "I am a teapot",
                details: undefined
            }
        });
    });

    test("sendError with generic Error", () => {
        const res = {
            status: mock((code) => res),
            json: mock((body) => { })
        } as any;
        const err = new Error("Something went wrong");
        sendError(res, err);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: "INTERNAL_ERROR",
                message: "Something went wrong",
                details: undefined
            }
        });
    });

    test("sendError with unknown object", () => {
        const res = {
            status: mock((code) => res),
            json: mock((body) => { })
        } as any;
        sendError(res, "just a string error");
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: "UNKNOWN_ERROR",
                message: "just a string error",
                details: undefined
            }
        });
    });
});

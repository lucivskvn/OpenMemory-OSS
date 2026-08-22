import { describe, test, expect, spyOn } from "bun:test";
import express from "express";
import { dash } from "../src/server/routes/dashboard";
import * as dbModule from "../src/core/db";

describe("Dashboard Route Error Message Sanitization", () => {
    test("sanitizes 500 error responses and does not leak e.message", async () => {
        const app = express();
        app.use(express.json());
        app.use((req: any, _res: any, next: any) => {
            req.tenant = "admin";
            next();
        });
        dash(app);

        // Spy on all_async to throw a simulated secret-leaking internal error
        const spy = spyOn(dbModule, "all_async").mockImplementation(() => {
            throw new Error(
                "SECRET_DATABASE_CONNECTION_STRING_LEAK: postgres://admin:secret_pass@10.0.0.1:5432/db",
            );
        });

        try {
            const server = app.listen(0);
            const port = (server.address() as any).port;

            const endpoints = [
                `/dashboard/projects`,
                `/dashboard/stats`,
                `/dashboard/activity`,
                `/dashboard/sectors/timeline`,
                `/dashboard/top-memories`,
                `/dashboard/maintenance`,
            ];

            for (const ep of endpoints) {
                const res = await fetch(`http://localhost:${port}${ep}`);
                expect(res.status).toBe(500);
                const body = await res.json();
                expect(body).toEqual({ err: "internal" });
                expect(JSON.stringify(body)).not.toContain(
                    "SECRET_DATABASE_CONNECTION_STRING_LEAK",
                );
                expect(body.message).toBeUndefined();
            }

            server.close();
        } finally {
            spy.mockRestore();
        }
    });
});

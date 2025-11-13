import { describe, it, expect } from "bun:test";

async function startAppWithRoutes(setup: (app: any) => void) {
    // Import the server factory directly so tests can attach custom routes.
    // Ensure modern-mode behavior for tests that expect a 500 when a modern
    // handler returns undefined. Tests that need legacy behavior can set the
    // env var explicitly.
    process.env.OM_LEGACY_HANDLER_MODE = 'false';
    process.env.OM_NO_AUTO_START = '1';
    const mod: any = await import("../../backend/src/server/server.ts");
    const createServer = mod.createServer;
    const app = createServer({ max_payload_size: 100000 });
    setup(app);
    const srv: any = app.listen(0);
    const port = (srv as any).port || 0;
    return { app, srv, port };
}

describe("legacy handler compatibility", () => {
    it("modern handler returning undefined -> 500", async () => {
        const { srv, port } = await startAppWithRoutes((app: any) => {
            app.get("/modern-undefined", async (req: Request, ctx: any) => {
                // Intentionally return undefined to simulate a buggy modern handler
                return undefined as any;
            });
        });

        const resp = await fetch(`http://localhost:${port}/modern-undefined`);
        expect(resp.status).toBe(500);  
        const body = await resp.json();
        expect(body.error).toBe("handler_returned_undefined");
        await srv.stop();
    });

    it("legacy-marked handler invoked via res shim and returns its response", async () => {
        const { srv, port } = await startAppWithRoutes((app: any) => {
            const legacy = (req: Request, res: any) => {
                res.status(201);
                res.send("legacy-ok");
            };
            // Mark as legacy explicitly
            (legacy as any).__legacy = true;
            app.get("/legacy-ok", legacy as any);
        });

        const resp = await fetch(`http://localhost:${port}/legacy-ok`);
        expect(resp.status).toBe(201);
        const text = await resp.text();
        expect(text).toBe("legacy-ok");
        await srv.stop();
    });
});

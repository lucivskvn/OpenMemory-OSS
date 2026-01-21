import { Elysia } from "elysia";
import * as path from "node:path";

export const homeRoutes = (app: Elysia) => app.get("/", () => {
    // Locate views relative to this file
    const possiblePaths = [
        path.resolve(__dirname, "../views/dashboard.html"),
        path.resolve(__dirname, "../../views/dashboard.html"),
        "src/server/views/dashboard.html",
    ];

    for (const p of possiblePaths) {
        const f = Bun.file(p);
        if (f.size > 0) {
            return f;
        }
    }

    return new Response("Dashboard UI not found (404)", { status: 404 });
});

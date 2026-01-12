import * as path from "node:path";

import {
    type AdvancedRequest,
    type AdvancedResponse,
    type ServerApp,
} from "../server";

interface BunResponse extends AdvancedResponse {
    _body?: unknown;
    // _headers is already defined in AdvancedResponse as Headers
    writableEnded?: boolean;
}

export function homeRoutes(app: ServerApp) {
    app.get("/", (req: AdvancedRequest, res: AdvancedResponse) => {
        // Locate views relative to this file
        // dist/server/routes/home.js -> .../src/server/views/dashboard.html (in dev) or dist/server/views/...
        // To be safe in dev and prod, we should try to find it.
        // Assuming we are running via bun source or build.

        const possiblePaths = [
            path.resolve(__dirname, "../views/dashboard.html"), // structure in src
            path.resolve(__dirname, "../../views/dashboard.html"), // if nested deeper
            "src/server/views/dashboard.html",
        ];

        let file;
        for (const p of possiblePaths) {
            const f = Bun.file(p);
            // Basic sync check not ideal but fine for startup/route determination
            if (f.size > 0) {
                file = f;
                break;
            }
        }

        if (file) {
            res.status(200);
            res.set("Content-Type", "text/html");
            // Server wrapper supports BunFile body
            const bRes = res as BunResponse;
            bRes._body = file;
            bRes.writableEnded = true;
        } else {
            res.send("Dashboard UI not found (404)");
        }
    });
}

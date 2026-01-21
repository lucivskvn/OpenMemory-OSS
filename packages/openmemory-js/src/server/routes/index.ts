import type { ServerApp } from "../server";
import { compressRoutes } from "./compression";
import { dash } from "./dashboard";
import { dynamicsRoutes } from "./dynamics";
import { ideRoutes } from "./ide";
import { langGraphRoutes } from "./langgraph";
import { memoryRoutes } from "./memory";
import { sourceRoutes } from "./sources";
import { systemRoutes } from "./system";
import { temporalRoutes } from "./temporal";
import { securityRoutes } from "./security";
import { userRoutes } from "./users";
import { vercelRoutes } from "./vercel";
import { webhookRoutes } from "./webhooks";

import { adminRoutes } from "./admin";
import { homeRoutes } from "./home";

export function routes(app: ServerApp) {
    homeRoutes(app); // Mount first (or last? "/" usually low priority or specific). 
    // Hono/Express routing order matters. 
    // homeRoutes defines app.get("/"). Specific paths like /api/... usually take precedence if defined earlier or due to path matching.
    // However, "/" is exact match usually.
    // Let's put it at the end to be safe, or start? 
    // Usually routes are checked in order. If "/" is specific, it's fine.
    // homeRoutes uses app.get("/").
    systemRoutes(app);
    memoryRoutes(app);
    dynamicsRoutes(app);
    ideRoutes(app);
    compressRoutes(app);
    langGraphRoutes(app);
    userRoutes(app);
    temporalRoutes(app);
    securityRoutes(app);
    dash(app); // dash handles /dashboard
    vercelRoutes(app);
    sourceRoutes(app);
    webhookRoutes(app);
    adminRoutes(app);
}

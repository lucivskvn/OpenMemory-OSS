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
import { userRoutes } from "./users";
import { vercelRoutes } from "./vercel";

export function routes(app: ServerApp) {
    systemRoutes(app);
    memoryRoutes(app);
    dynamicsRoutes(app);
    ideRoutes(app);
    compressRoutes(app);
    langGraphRoutes(app);
    userRoutes(app);
    temporalRoutes(app);
    dash(app);
    vercelRoutes(app);
    sourceRoutes(app);
}

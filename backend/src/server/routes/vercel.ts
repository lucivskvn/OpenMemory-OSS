import { Elysia } from "elysia";

export const vercel = (app: Elysia) =>
    app.group("/api", (app) =>
        app.get("/vercel", () => {
            return { platform: "vercel" };
        })
    );

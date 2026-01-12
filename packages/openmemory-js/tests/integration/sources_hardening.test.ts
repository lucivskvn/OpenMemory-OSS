import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { app } from "../../src/server/index";
import { q, closeDb, runAsync } from "../../src/core/db";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { reloadConfig } from "../../src/core/cfg";
import { createHmac } from "crypto";
import { Memory } from "../../src/core/memory";

async function getClientId(apiKey: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", Buffer.from(apiKey));
    return Buffer.from(hash).toString("hex").slice(0, 16);
}

describe("Sources Routes Hardening", () => {
    let server: any;
    const adminKey = "admin-key-src";
    let adminId: string;
    const GITHUB_SECRET = "gh_secret_test";
    const NOTION_SECRET = "notion_secret_test";

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        reloadConfig();
        adminId = await getClientId(adminKey);

        process.env.OM_ADMIN_KEY = adminKey;
        process.env.GITHUB_WEBHOOK_SECRET = GITHUB_SECRET;
        process.env.NOTION_WEBHOOK_SECRET = NOTION_SECRET;
        process.env.OM_LOG_LEVEL = "debug"; // Force debug
        process.env.OM_VERBOSE = "true";
        reloadConfig();

        // Also configure logger directly
        const { configureLogger } = await import("../../src/utils/logger");
        configureLogger({ verbose: true, logLevel: "debug", mode: "dev" });

        server = app;
    });

    afterAll(async () => {
        await stopAllMaintenance();
        await closeDb();
    });

    beforeEach(async () => {
        await runAsync("DELETE FROM users");
        await runAsync("DELETE FROM memories");
        await runAsync("DELETE FROM source_configs");
        await q.insUser.run(adminId, "Admin", 0, Date.now(), Date.now());
    });

    const request = async (path: string, options: any = {}) => {
        const url = `http://localhost:8080${path}`;
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...options.headers
        };

        if (options.body && typeof options.body === "string") {
            headers["Content-Length"] = Buffer.byteLength(options.body).toString();
        }

        return await server.fetch(new Request(url, { ...options, headers }));
    };

    describe("GitHub Webhooks", () => {
        it("Should accept valid signature", async () => {
            const payload = JSON.stringify({
                commits: [{ message: "test commit", url: "http://github.com" }],
                repository: { full_name: "test/repo" },
                ref: "refs/heads/main"
            });

            const hmac = createHmac('sha256', GITHUB_SECRET);
            const signature = 'sha256=' + hmac.update(payload).digest('hex');

            const res = await request("/sources/webhook/github", {
                method: "POST",
                headers: {
                    "x-github-event": "push",
                    "x-hub-signature-256": signature
                },
                body: payload
            });

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.ok).toBe(true);
            expect(body.event).toBe("push");
        });

        it("Should reject invalid signature", async () => {
            const payload = JSON.stringify({ foo: "bar" });
            const res = await request("/sources/webhook/github", {
                method: "POST",
                headers: {
                    "x-github-event": "push",
                    "x-hub-signature-256": "sha256=invalid"
                },
                body: payload
            });
            expect(res.status).toBe(401);
        });

        it("Should reject missing signature when secret configured", async () => {
            const payload = JSON.stringify({ foo: "bar" });
            const res = await request("/sources/webhook/github", {
                method: "POST",
                headers: {
                    "x-github-event": "push"
                },
                body: payload
            });
            expect(res.status).toBe(401);
        });
    });

    describe("Notion Webhooks", () => {
        it("Should accept valid secret", async () => {
            const payload = JSON.stringify({ object: "page" });
            const res = await request(`/sources/webhook/notion?secret=${NOTION_SECRET}`, {
                method: "POST",
                body: payload
            });
            expect(res.status).toBe(200);
        });

        it("Should reject invalid secret", async () => {
            const payload = JSON.stringify({ object: "page" });
            const res = await request("/sources/webhook/notion?secret=wrong", {
                method: "POST",
                body: payload
            });
            if (res.status === 400) {
                const b = await res.json();
                console.log("DEBUG RESPONSE BODY:", JSON.stringify(b));
            }
            expect(res.status).toBe(401);
        });

        it("Should reject empty payload", async () => {
            // We added this check in refactor
            const res = await request(`/sources/webhook/notion?secret=${NOTION_SECRET}`, {
                method: "POST",
                body: "{}"
            });
            expect(res.status).toBe(400);
        });
    });

    describe("Source Configs", () => {
        it("Should hide secrets in listings", async () => {
            // Create a config
            // We need a valid user for this.
            // Using adminId.
            const fakeToken = "super-secret-token";
            await q.insSourceConfig.run(adminId, "github", JSON.stringify({ token: fakeToken }), "enabled", Date.now(), Date.now());

            // List
            const res = await request("/source-configs", {
                headers: { "x-api-key": adminKey }
            });

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.configs).toHaveLength(1);
            expect(body.configs[0].type).toBe("github");
            // Check it doesn't contain 'config' field or if it does, it's safe?
            // The route maps: { type, status, updatedAt }
            expect(body.configs[0]).not.toHaveProperty("config");
            expect(JSON.stringify(body)).not.toContain(fakeToken);
        });
    });
});

/**
 * Webhook HMAC verification regression guard.
 *
 * Pins the behaviour of verify_github_signature / verify_notion_signature
 * BEFORE the src/server/server.js -> server.ts port. The "raw_body missing"
 * case is the explicit regression guard: if the typed framework drops
 * raw-body capture, this test fails loudly instead of silently fail-opening
 * the webhook (the verifier returns ok:false / reason:"raw_body_missing"
 * which the route translates to 401).
 *
 * The middleware exposes pure functions, not Express-style (req,res,next)
 * middleware:
 *   verify_github_signature(raw_body, header_value, secret) -> { ok, reason? }
 *   verify_notion_signature(raw_body, header_value, secret) -> { ok, reason? }
 *
 * Routes call these via req.rawBody / req.headers[...] / process.env.* and
 * map verify.ok=false to HTTP 401 (or 503 when secret is unset).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as crypto from "crypto";
import {
    verify_github_signature,
    verify_notion_signature,
} from "../src/server/middleware/webhook";
import { src } from "../src/server/routes/sources";
import { run_async, q } from "../src/core/db";

const PAYLOAD = Buffer.from(JSON.stringify({ event: "ping" }));
const SECRET = "test-secret";

function github_sig(secret: string, body: Buffer): string {
    return (
        "sha256=" +
        crypto.createHmac("sha256", secret).update(body).digest("hex")
    );
}

function notion_sig(secret: string, body: Buffer): string {
    // Notion verifier accepts bare hex or "sha256=<hex>". Use bare hex to
    // mirror the README / route documentation.
    return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("webhook HMAC verification (GitHub)", () => {
    it("accepts a valid signature", () => {
        const result = verify_github_signature(
            PAYLOAD,
            github_sig(SECRET, PAYLOAD),
            SECRET,
        );
        expect(result.ok).toBe(true);
    });

    it("rejects a forged signature with reason=mismatch", () => {
        const result = verify_github_signature(
            PAYLOAD,
            github_sig("wrong-secret", PAYLOAD),
            SECRET,
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("mismatch");
    });

    it("rejects when the secret is missing (server misconfigured -> 503 path)", () => {
        const result = verify_github_signature(
            PAYLOAD,
            github_sig("anything", PAYLOAD),
            undefined,
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("secret_missing");
    });

    it("rejects when raw_body is missing (server framework regression guard)", () => {
        // This is the load-bearing test for the server.js -> server.ts port.
        // If the typed framework drops req.rawBody capture, the route hands
        // undefined to the verifier and we MUST fail closed.
        const result = verify_github_signature(
            undefined,
            github_sig(SECRET, PAYLOAD),
            SECRET,
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("raw_body_missing");
    });

    it("rejects when the signature header is missing", () => {
        const result = verify_github_signature(PAYLOAD, undefined, SECRET);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("header_missing");
    });

    it("rejects when the signature header is malformed (no sha256= prefix)", () => {
        const result = verify_github_signature(PAYLOAD, "deadbeef", SECRET);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("bad_format");
    });
});

describe("webhook HMAC verification (Notion)", () => {
    it("accepts a valid bare-hex signature", () => {
        const result = verify_notion_signature(
            PAYLOAD,
            notion_sig(SECRET, PAYLOAD),
            SECRET,
        );
        expect(result.ok).toBe(true);
    });

    it('accepts a valid "sha256=<hex>" prefixed signature', () => {
        const result = verify_notion_signature(
            PAYLOAD,
            "sha256=" + notion_sig(SECRET, PAYLOAD),
            SECRET,
        );
        expect(result.ok).toBe(true);
    });

    it("rejects when raw_body is missing (server framework regression guard)", () => {
        const result = verify_notion_signature(
            undefined,
            notion_sig(SECRET, PAYLOAD),
            SECRET,
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("raw_body_missing");
    });

    it("rejects when the secret is missing", () => {
        const result = verify_notion_signature(
            PAYLOAD,
            notion_sig("anything", PAYLOAD),
            undefined,
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("secret_missing");
    });
});

describe("webhook endpoints multi-tenant isolation and error sanitization", () => {
    let github_handler: any = null;
    let notion_handler: any = null;

    const app_mock = {
        get: () => {},
        post: (path: string, handler: any) => {
            if (path === "/sources/webhook/github") github_handler = handler;
            if (path === "/sources/webhook/notion") notion_handler = handler;
        },
    };

    src(app_mock);

    beforeEach(async () => {
        await run_async(`DELETE FROM memories`);
    });

    it("GitHub webhook: isolates tenant using user_id query param", async () => {
        process.env.OM_GITHUB_WEBHOOK_SECRET = SECRET;
        const payload = { commits: [{ message: "fix: secure error messages", url: "https://github.com" }] };
        const payload_buf = Buffer.from(JSON.stringify(payload));

        const req = {
            query: { user_id: "alice-tenant" },
            headers: {
                "x-hub-signature-256": github_sig(SECRET, payload_buf),
                "x-github-event": "push",
            },
            rawBody: payload_buf,
            body: payload,
        };

        let status_code = 200;
        let response_json: any = null;
        const res = {
            status: function (code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                response_json = data;
            },
        };

        await github_handler(req, res);
        expect(status_code).toBe(200);
        expect(response_json.ok).toBe(true);

        const memory_id = response_json.memory_id;
        expect(memory_id).toBeTruthy();

        // Retrieve from database and verify it belongs to alice-tenant
        const saved = await q.get_mem.get(memory_id);
        expect(saved).toBeTruthy();
        expect(saved.user_id).toBe("alice-tenant");
    });

    it("GitHub webhook: rejects invalid/too long user_id with 400", async () => {
        process.env.OM_GITHUB_WEBHOOK_SECRET = SECRET;
        const payload = { commits: [] };
        const payload_buf = Buffer.from(JSON.stringify(payload));

        const req = {
            query: { user_id: "a".repeat(300) },
            headers: {
                "x-hub-signature-256": github_sig(SECRET, payload_buf),
                "x-github-event": "push",
            },
            rawBody: payload_buf,
            body: payload,
        };

        let status_code = 200;
        let response_json: any = null;
        const res = {
            status: function (code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                response_json = data;
            },
        };

        await github_handler(req, res);
        expect(status_code).toBe(400);
        expect(response_json.error).toBe("invalid_user_id");
    });

    it("GitHub webhook: secure error response when ingestion fails", async () => {
        process.env.OM_GITHUB_WEBHOOK_SECRET = SECRET;
        // Pass commits as a non-array to trigger TypeError inside the push event processing
        const payload = { commits: 123 };
        const payload_buf = Buffer.from(JSON.stringify(payload));

        const req = {
            query: {},
            headers: {
                "x-hub-signature-256": github_sig(SECRET, payload_buf),
                "x-github-event": "push",
            },
            rawBody: payload_buf,
            body: payload,
        };

        let status_code = 200;
        let response_json: any = null;
        const res = {
            status: function (code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                response_json = data;
            },
        };

        await github_handler(req, res);
        expect(status_code).toBe(500);
        expect(response_json.error).toBe("Webhook processing failed");
    });

    it("Notion webhook: isolates tenant using user_id query param", async () => {
        process.env.OM_NOTION_WEBHOOK_SECRET = SECRET;
        const payload = { test: "data" };
        const payload_buf = Buffer.from(JSON.stringify(payload));

        const req = {
            query: { user_id: "bob-tenant" },
            headers: {
                "x-notion-signature": notion_sig(SECRET, payload_buf),
            },
            rawBody: payload_buf,
            body: payload,
        };

        let status_code = 200;
        let response_json: any = null;
        const res = {
            status: function (code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                response_json = data;
            },
        };

        await notion_handler(req, res);
        expect(status_code).toBe(200);
        expect(response_json.ok).toBe(true);

        const memory_id = response_json.memory_id;
        expect(memory_id).toBeTruthy();

        // Retrieve from database and verify it belongs to bob-tenant
        const saved = await q.get_mem.get(memory_id);
        expect(saved).toBeTruthy();
        expect(saved.user_id).toBe("bob-tenant");
    });

    it("Notion webhook: rejects invalid/too long user_id with 400", async () => {
        process.env.OM_NOTION_WEBHOOK_SECRET = SECRET;
        const payload = { test: "data" };
        const payload_buf = Buffer.from(JSON.stringify(payload));

        const req = {
            query: { user_id: "b".repeat(300) },
            headers: {
                "x-notion-signature": notion_sig(SECRET, payload_buf),
            },
            rawBody: payload_buf,
            body: payload,
        };

        let status_code = 200;
        let response_json: any = null;
        const res = {
            status: function (code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                response_json = data;
            },
        };

        await notion_handler(req, res);
        expect(status_code).toBe(400);
        expect(response_json.error).toBe("invalid_user_id");
    });

    it("Notion webhook: secure error response when ingestion fails", async () => {
        process.env.OM_NOTION_WEBHOOK_SECRET = SECRET;
        // Use a circular structure in body to trigger JSON.stringify TypeError inside the try block.
        // We pass a valid rawBody and signature so that verify_notion_signature succeeds.
        const circular: any = {};
        circular.self = circular;

        const payload_buf = Buffer.from(JSON.stringify({ test: "ok" }));

        const req = {
            query: {},
            headers: {
                "x-notion-signature": notion_sig(SECRET, payload_buf),
            },
            rawBody: payload_buf,
            body: circular,
        };

        let status_code = 200;
        let response_json: any = null;
        const res = {
            status: function (code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                response_json = data;
            },
        };

        await notion_handler(req, res);

        expect(status_code).toBe(500);
        expect(response_json.error).toBe("Webhook processing failed");
    });
});

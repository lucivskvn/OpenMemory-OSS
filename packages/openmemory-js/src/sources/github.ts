/**
 * GitHub Source Connector for OpenMemory.
 * Ingests files, issues, and discussions from GitHub repositories.
 * Requires: @octokit/rest
 * Environment: GITHUB_TOKEN (optional fallback)
 */

import type { Octokit } from "@octokit/rest";


import { env } from "../core/cfg";
import { normalizeUserId } from "../utils";
import { logger } from "../utils/logger";
import {
    BaseSource,
    SourceConfigError,
    SourceContent,
    SourceFetchError,
    SourceItem,
} from "./base";

// Helper for timing-safe string comparison
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    }
    return mismatch === 0;
}

// Helper for hex conversion if needed, but we used manual map above.
// Keep it simple.

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, (i * 2) + 2), 16);
    }
    return bytes;
}

export interface GithubCreds {
    token?: string;
}

export interface GithubFilters {
    repo: string; // owner/repo
    path?: string;
    branch?: string;
    includeIssues?: boolean;
    recursive?: boolean;
}

/**
 * GitHub Source Connector.
 * Ingests files and issues from GitHub repositories.
 * Supports:
 * - Filtering by path
 * - Including issues/comments
 * - Auto-detecting encoding
 */
export class GithubSource extends BaseSource<GithubCreds, GithubFilters> {
    override name = "github";
    private octokit: Octokit | null = null;

    async _connect(creds: GithubCreds): Promise<boolean> {
        let OctokitConstructor: typeof Octokit;
        try {
            OctokitConstructor = await import("@octokit/rest").then(
                (m) => m.Octokit,
            );
        } catch {
            throw new SourceConfigError(
                "missing deps: npm install @octokit/rest",
                this.name,
            );
        }

        // Standardize userId
        this.userId = normalizeUserId(this.userId);

        // Security: BaseSource.connect has already hydrated creds from Persisted Config
        // Fallback to env.githubToken if no token provided at all
        const token = creds.token || env.githubToken;

        if (!token) {
            throw new SourceConfigError(
                "GitHub token is required (provide in Dashboard or OM_GITHUB_TOKEN)",
                this.name,
            );
        }

        this.octokit = new OctokitConstructor({ auth: token });
        return true;
    }

    /**
     * Verifies the HMAC signature of a GitHub webhook payload.
     * @param signature The X-Hub-Signature-256 header value
     * @param body The raw request body
     * @param secret The webhook secret
     */
    static async verifySignature(
        signature: string,
        body: string | Uint8Array,
        secret: string,
    ): Promise<boolean> {
        if (!signature || !secret) return false;

        const enc = new TextEncoder();
        const algorithm = { name: "HMAC", hash: "SHA-256" };
        const key = await globalThis.crypto.subtle.importKey(
            "raw",
            enc.encode(secret) as unknown as BufferSource,
            algorithm,
            false,
            ["sign", "verify"],
        );

        const bodyBytes = typeof body === "string" ? enc.encode(body) : body;
        const signatureBytes = hexToBytes(signature.replace("sha256=", "")); // Helper needed? Or just compare hex.

        // Actually better to just verify directly using the API if we parse the signature hex to bytes.
        // But subtle.verify expects raw bytes. GitHub sends hex.

        // Let's compute the signature locally and compare hex strings to avoid hex parsing issues,
        // but timing safe comparison is needed.
        const signed = await globalThis.crypto.subtle.sign(
            algorithm,
            key,
            bodyBytes as any
        );

        const digest = "sha256=" + Array.from(new Uint8Array(signed)).map(b => b.toString(16).padStart(2, '0')).join('');

        return timingSafeEqual(digest, signature);
    }

    async _listItems(filters: GithubFilters): Promise<SourceItem[]> {
        if (!this.octokit)
            throw new SourceConfigError("not connected", this.name);
        if (!filters.repo) {
            throw new SourceConfigError(
                "repo is required (format: owner/repo)",
                this.name,
            );
        }

        const [owner, repo] = filters.repo.split("/");
        const path = filters.path?.replace(/^\//, "") || "";
        const includeIssues = filters.includeIssues || false;
        const recursive = filters.recursive !== false;

        const results: SourceItem[] = [];

        try {
            if (recursive && !path) {
                // Recursive listing (Git Tree API) - More efficient for deep structures
                const files = await this._listRecursive(
                    owner,
                    repo,
                    filters.branch,
                );
                results.push(...files);
            } else {
                // Simple listing (Contents API) - Better for specific paths
                const files = await this._listSimple(owner, repo, path);
                results.push(...files);
            }
            await this.rateLimiter.acquire();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn(`[github] Failed to list ${path || "root"}: ${msg}`);
        }

        if (includeIssues) {
            try {
                const issues = await this._listIssues(owner, repo);
                results.push(...issues);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.warn(`[github] Failed to list issues: ${msg}`);
            }
        }

        return results;
    }

    private async _listRecursive(
        owner: string,
        repo: string,
        branch?: string,
    ): Promise<SourceItem[]> {
        if (!this.octokit) return [];
        const tree = await this.octokit.git.getTree({
            owner,
            repo,
            tree_sha: branch || "HEAD",
            recursive: "true",
        });

        if (tree.data.truncated) {
            logger.warn(
                `[github] Tree for ${owner}/${repo} is truncated! Some files may be missing.`,
            );
        }

        const IGNORE_EXTS = [
            ".exe", ".bin", ".zip", ".tar", ".gz", ".lock", ".pyc",
            ".pdf", ".jpg", ".png", ".gif", ".mp4", ".mov", ".db", ".sqlite",
            ".env", ".pem", ".key", ".cert", ".ds_store", ".crt"
        ];

        return tree.data.tree
            .filter((item) => {
                if (item.type !== "blob" || !item.path) return false;
                const ext = item.path.split(".").pop()?.toLowerCase();
                return ext && !IGNORE_EXTS.includes(`.${ext}`);
            })
            .map((item) => ({
                id: `${owner}/${repo}:${item.path}`,
                name: item.path?.split("/").pop() || "unknown",
                type: "file",
                path: item.path || "",
                size: item.size || 0,
                sha: item.sha,
            }));
    }

    private async _listSimple(
        owner: string,
        repo: string,
        path: string,
    ): Promise<SourceItem[]> {
        if (!this.octokit) return [];
        const resp = await this.octokit.repos.getContent({ owner, repo, path });
        const contents = Array.isArray(resp.data) ? resp.data : [resp.data];

        return contents.map((content) => {
            const encoding =
                "encoding" in content ? String(content.encoding) : undefined;
            return {
                id: `${owner}/${repo}:${content.path}`,
                name: content.name,
                type: content.type === "dir" ? "dir" : encoding || "file",
                path: content.path,
                size: content.size || 0,
                sha: content.sha,
            };
        });
    }

    async _listIssues(owner: string, repo: string): Promise<SourceItem[]> {
        if (!this.octokit) return [];

        const allIssues: SourceItem[] = [];
        let page = 1;
        let retryCount = 0;

        while (true) {
            try {
                const resp = await (this.octokit as Octokit).issues.listForRepo({
                    owner,
                    repo,
                    state: "all",
                    per_page: 100,
                    page,
                });

                if (resp.data.length === 0) break;

                const batched = resp.data.map((issue) => ({
                    id: `${owner}/${repo}:issue:${issue.number}`,
                    name: issue.title,
                    type: "issue",
                    number: issue.number,
                    state: issue.state,
                    labels: (issue.labels || []).map((l) =>
                        typeof l === "string" ? l : l.name || "unknown",
                    ),
                }));

                allIssues.push(...batched);
                retryCount = 0; // Reset on success

                if (allIssues.length >= 1000) {
                    logger.warn(
                        `[github] Hit hard limit of 1000 issues for ${owner}/${repo}`,
                    );
                    break;
                }

                if (resp.data.length < 100) break;
                page++;

                await this.rateLimiter.acquire();
            } catch (e: any) {
                const msg = e.message || String(e);
                const isRateLimit = e.status === 403 || e.status === 429 || msg.includes("rate limit");

                if (isRateLimit && retryCount < 3) {
                    retryCount++;
                    const wait = Math.pow(2, retryCount) * 1000;
                    logger.warn(`[github] Rate limit hit, retrying in ${wait}ms...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }

                logger.warn(`[github] Issue retrieval failed: ${msg}`);
                break;
            }
        }

        return allIssues;
    }

    private redactSecrets(text: string): string {
        // Simple regexes for common secrets - to be expanded
        const patterns = [
            /([a-z0-9_-])*(key|secret|token|password|passwd|auth)=['"]?([a-z0-9_-]){4,}['"]?/gi,
            /AIza[0-9A-Za-z-_]{35}/g, // Google API Key
            /sk-[a-zA-Z0-9]{48}/g,    // OpenAI Key
            /sq0csp-[ a-zA-Z0-9-_]{43}/g, // Square secret
            /ghp_[a-zA-Z0-9]{36}/g,    // GitHub Personal Access Token
        ];

        let redacted = text;
        for (const pattern of patterns) {
            redacted = redacted.replace(pattern, (match) => {
                return match.split("=")[0] + "=[REDACTED]";
            });
        }
        return redacted;
    }

    async _fetchItem(itemId: string): Promise<SourceContent> {
        if (!this.octokit)
            throw new SourceConfigError("not connected", this.name);

        const parts = itemId.split(":");
        const repoFull = parts[0];
        const [owner, repo] = repoFull.split("/");

        // issue
        if (parts.length >= 3 && parts[1] === "issue") {
            const issueNum = parseInt(parts[2]);
            const issue = await this.octokit.issues.get({
                owner,
                repo,
                issue_number: issueNum,
            });

            // Fetch comments with pagination (limit to 500 total to avoid massive memories)
            const textParts = [
                `# ${issue.data.title}`,
                `**State:** ${issue.data.state}`,
                `**Labels:** ${issue.data.labels.map((l) => (typeof l === "string" ? l : l.name || "unknown")).join(", ")}`,
                "",
                issue.data.body || "",
            ];

            let commentPage = 1;
            let totalComments = 0;
            while (totalComments < 500) {
                const comments = await this.octokit.issues.listComments({
                    owner,
                    repo,
                    issue_number: issueNum,
                    per_page: 100,
                    page: commentPage,
                });

                if (comments.data.length === 0) break;

                for (const comment of comments.data) {
                    textParts.push(
                        `\n---\n**${comment.user?.login}:** ${comment.body}`,
                    );
                }

                totalComments += comments.data.length;
                if (comments.data.length < 100) break;
                commentPage++;
            }

            const text = this.redactSecrets(textParts.join("\n"));

            return {
                id: itemId,
                name: issue.data.title,
                type: "issue",
                text,
                data: text,
                metadata: {
                    source: "github",
                    repo: repoFull,
                    issueNumber: issueNum,
                    state: issue.data.state,
                },
            };
        }

        // file
        const path = parts.slice(1).join(":");
        const resp = await this.octokit.repos.getContent({ owner, repo, path });

        if (Array.isArray(resp.data)) {
            const text = resp.data.map((c) => `- ${c.path}`).join("\n");
            return {
                id: itemId,
                name: path || repoFull,
                type: "directory",
                text,
                data: text,
                metadata: { source: "github", repo: repoFull, path },
            };
        }

        const content = resp.data;
        if (!("content" in content)) {
            throw new Error("Not a file");
        }

        let text = "";
        let data: string | Buffer = "";

        const size = content.size || 0;
        if (size > 10 * 1024 * 1024) {
            throw new SourceFetchError(
                `File too large: ${size} bytes (max 10MB)`,
                this.name,
            );
        }

        if (content.content) {
            data = Buffer.from(content.content, "base64");
            try {
                text = this.redactSecrets(data.toString("utf-8"));
            } catch {
                // ignore
            }
        }

        const encoding =
            "encoding" in content ? String(content.encoding) : "file";

        return {
            id: itemId,
            name: content.name,
            type: encoding,
            text,
            data,
            metadata: {
                source: "github",
                repo: repoFull,
                path: content.path,
                sha: content.sha,
                size: content.size,
            },
        };
    }
}

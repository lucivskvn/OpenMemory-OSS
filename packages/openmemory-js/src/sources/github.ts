/**
 * GitHub Source Connector for OpenMemory.
 * Ingests files, issues, and discussions from GitHub repositories.
 * Requires: @octokit/rest
 * Environment: GITHUB_TOKEN (optional fallback)
 */

import type { Octokit } from "@octokit/rest";
import { createHmac, timingSafeEqual } from "crypto";

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
    static verifySignature(
        signature: string,
        body: string | Buffer,
        secret: string,
    ): boolean {
        if (!signature || !secret) return false;
        const hmac = createHmac("sha256", secret);
        const digest = Buffer.from(
            "sha256=" + hmac.update(body).digest("hex"),
            "utf8",
        );
        const checksum = Buffer.from(signature, "utf8");
        if (checksum.length !== digest.length) return false;
        return timingSafeEqual(digest, checksum);
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
            ".pdf", ".jpg", ".png", ".gif", ".mp4", ".mov", ".db", ".sqlite"
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

        while (true) {
            try {
                const resp = await this.octokit.issues.listForRepo({
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

                if (allIssues.length >= 1000) {
                    logger.warn(
                        `[github] Hit hard limit of 1000 issues for ${owner}/${repo}`,
                    );
                    break;
                }

                if (resp.data.length < 100) break;
                page++;

                // Respect rate limits gently (Centralized + Small extra buffer)
                await this.rateLimiter.acquire();
                await new Promise((r) => setTimeout(r, 100));
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                // Simple retry logic for rate limits could go here, but for now just break to avoid infinite loops
                if (msg.includes("429") || msg.includes("403")) {
                    logger.warn(
                        `[github] Rate limit hit on page ${page}: ${msg}`,
                    );
                    break;
                }
                logger.warn(
                    `[github] Issue retrieval failed on page ${page}: ${msg}`,
                );
                break;
            }
        }

        return allIssues;
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

            const text = textParts.join("\n");

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
                text = data.toString("utf-8");
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

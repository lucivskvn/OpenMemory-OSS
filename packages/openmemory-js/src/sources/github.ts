/**
 * github source for openmemory - production grade
 * requires: @octokit/rest
 * env vars: GITHUB_TOKEN
 */

import { base_source, source_config_error, source_item, source_content } from './base';
import type { Octokit } from '@octokit/rest';
import { env } from '../core/cfg';

/**
 * GitHub Source Connector.
 * Ingests files and issues from GitHub repositories.
 * Supports:
 * - Filtering by path
 * - Including issues/comments
 * - Auto-detecting encoding
 */
export class github_source extends base_source {
    override name = 'github';
    private octokit: Octokit | null = null;

    async _connect(creds: Record<string, any>): Promise<boolean> {
        let OctokitConstructor: typeof Octokit;
        try {
            OctokitConstructor = await import('@octokit/rest').then(m => m.Octokit);
        } catch {
            throw new source_config_error('missing deps: npm install @octokit/rest', this.name);
        }

        const token = (creds.token as string) || process.env.GITHUB_TOKEN;

        if (!token) {
            throw new source_config_error('no credentials: set GITHUB_TOKEN', this.name);
        }

        this.octokit = new OctokitConstructor({ auth: token });
        return true;
    }

    async _list_items(filters: Record<string, any>): Promise<source_item[]> {
        if (!this.octokit) throw new source_config_error('not connected', this.name);
        if (!filters.repo) {
            throw new source_config_error('repo is required (format: owner/repo)', this.name);
        }

        const [owner, repo] = (filters.repo as string).split('/');
        const path = (filters.path as string)?.replace(/^\//, '') || '';
        const include_issues = (filters.include_issues as boolean) || false;

        const results: source_item[] = [];

        // list files
        try {
            const resp = await this.octokit.repos.getContent({ owner, repo, path });
            const contents = Array.isArray(resp.data) ? resp.data : [resp.data];

            for (const content of contents) {
                if ('type' in content) {
                    results.push({
                        id: `${filters.repo}:${content.path}`,
                        name: content.name,
                        type: content.type === 'dir' ? 'dir' : (content as any).encoding || 'file',
                        path: content.path,
                        size: content.size || 0,
                        sha: content.sha
                    });
                }
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (env.verbose) console.warn(`[github] failed to list ${path}: ${msg}`);
        }

        // list issues if requested
        if (include_issues) {
            try {
                const resp = await this.octokit.issues.listForRepo({ owner, repo, state: 'all', per_page: 50 });

                for (const issue of resp.data) {
                    results.push({
                        id: `${filters.repo}:issue:${issue.number}`,
                        name: issue.title,
                        type: 'issue',
                        number: issue.number,
                        state: issue.state,
                        labels: issue.labels.map((l: any) => typeof l === 'string' ? l : l.name)
                    });
                }
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                if (env.verbose) console.warn(`[github] failed to list issues: ${msg}`);
            }
        }

        return results;
    }

    async _fetch_item(item_id: string): Promise<source_content> {
        if (!this.octokit) throw new source_config_error('not connected', this.name);

        const parts = item_id.split(':');
        const repo_full = parts[0];
        const [owner, repo] = repo_full.split('/');

        // issue
        if (parts.length >= 3 && parts[1] === 'issue') {
            const issue_num = parseInt(parts[2]);
            const issue = await this.octokit.issues.get({ owner, repo, issue_number: issue_num });

            const comments = await this.octokit.issues.listComments({ owner, repo, issue_number: issue_num });

            const text_parts = [
                `# ${issue.data.title}`,
                `**State:** ${issue.data.state}`,
                `**Labels:** ${issue.data.labels.map((l: any) => typeof l === 'string' ? l : l.name).join(', ')}`,
                '',
                issue.data.body || ''
            ];

            for (const comment of comments.data) {
                text_parts.push(`\n---\n**${comment.user?.login}:** ${comment.body}`);
            }

            const text = text_parts.join('\n');

            return {
                id: item_id,
                name: issue.data.title,
                type: 'issue',
                text,
                data: text,
                meta: { source: 'github', repo: repo_full, issue_number: issue_num, state: issue.data.state }
            };
        }

        // file
        const path = parts.slice(1).join(':');
        const resp = await this.octokit.repos.getContent({ owner, repo, path });

        if (Array.isArray(resp.data)) {
            const text = resp.data.map((c) => `- ${c.path}`).join('\n');
            return {
                id: item_id,
                name: path || repo_full,
                type: 'directory',
                text,
                data: text,
                meta: { source: 'github', repo: repo_full, path }
            };
        }

        const content = resp.data;
        if (!('content' in content)) {
            throw new Error('Not a file');
        }

        let text = '';
        let data: string | Buffer = '';

        if (content.content) {
            data = Buffer.from(content.content, 'base64');
            try {
                text = data.toString('utf-8');
            } catch { }
        }

        return {
            id: item_id,
            name: content.name,
            type: (content as any).encoding || 'file',
            text,
            data,
            meta: { source: 'github', repo: repo_full, path: content.path, sha: content.sha, size: content.size }
        };
    }
}

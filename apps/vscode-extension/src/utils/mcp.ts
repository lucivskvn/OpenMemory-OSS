import * as path from 'path';
import * as os from 'os';

/**
 * Resolves the path to the OpenMemory MCP server script.
 * @param customPath Optional custom path provided by user.
 * @returns Resolved absolute path.
 */
export function resolveMcpPath(customPath?: string): string {
    if (customPath) return customPath;

    try {
        // Try to resolve via node_modules (monorepo or installed)
        return require.resolve('openmemory-js/ai/mcp.js');
    } catch {
        try {
            // Try without .js extension if necessary
            return require.resolve('openmemory-js/ai/mcp');
        } catch {
            // Fallback for isolated environments or local dev
            return path.join(os.homedir(), '.opm', 'mcp.js');
        }
    }
}

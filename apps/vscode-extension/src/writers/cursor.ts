import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMcpPath } from '../utils/mcp';

export interface CursorConfig {
    name: string;
    type: string;
    endpoint?: string;
    method?: string;
    headers?: Record<string, string>;
    body_template?: Record<string, unknown>;
    mcp?: {
        server: string;
        tools: string[];
    };
}

/**
 * Generates a Cursor IDE configuration object for OpenMemory integration.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Configuration object for Cursor
 */
export function generateCursorConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): CursorConfig {
    if (useMCP) {
        const backendMcpPath = resolveMcpPath(mcpServerPath);
        return {
            name: 'OpenMemory',
            type: 'mcp',
            mcp: {
                server: backendMcpPath,
                tools: ['openmemory_query', 'openmemory_store', 'openmemory_list', 'openmemory_get', 'openmemory_reinforce']
            }
        };
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    return {
        name: 'OpenMemory',
        type: 'http',
        endpoint: `${backendUrl}/api/ide/context`,
        method: 'POST',
        headers,
        body_template: {
            query: '{{prompt}}',
            limit: 10,
            sessionId: '{{session_id}}'
        }
    };
}

/**
 * Writes the OpenMemory configuration file for Cursor IDE.
 * Creates the necessary directories if they don't exist.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Path to the created configuration file
 * @throws Error if the configuration cannot be written (e.g., permission denied)
 */
export function writeCursorConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): string {
    const cursorDir = path.join(os.homedir(), '.cursor', 'context_providers');
    const configFile = path.join(cursorDir, 'openmemory.json');

    try {
        if (!fs.existsSync(cursorDir)) {
            fs.mkdirSync(cursorDir, { recursive: true });
        }

        const config = generateCursorConfig(backendUrl, apiKey, useMCP, mcpServerPath);
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

        return configFile;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write Cursor config to ${configFile}: ${message}`);
    }
}


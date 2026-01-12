import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMcpPath } from '../utils/mcp';

export interface ClaudeConfig {
    mcpServers?: {
        openmemory: {
            command: string;
            args: string[];
            env?: Record<string, string>;
        };
    };
    provider?: string;
    base_url?: string;
    api_key?: string;
}

/**
 * Generates a Claude Desktop configuration object for OpenMemory integration.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Configuration object for Claude Desktop
 */
export function generateClaudeConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): ClaudeConfig {
    if (useMCP) {
        const backendMcpPath = resolveMcpPath(mcpServerPath);
        return {
            mcpServers: {
                openmemory: {
                    command: 'node',
                    args: [backendMcpPath],
                    env: apiKey ? { OM_API_KEY: apiKey } : undefined
                }
            }
        };
    }

    const config: ClaudeConfig = {
        provider: 'http',
        base_url: `${backendUrl}/api/ide/context`
    };
    if (apiKey) config.api_key = apiKey;
    return config;
}

/**
 * Writes the OpenMemory configuration file for Claude Desktop.
 * Creates the necessary directories if they don't exist.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Path to the created configuration file
 * @throws Error if the configuration cannot be written (e.g., permission denied)
 */
export function writeClaudeConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): string {
    const claudeDir = path.join(os.homedir(), '.claude', 'providers');
    const configFile = path.join(claudeDir, 'openmemory.json');

    try {
        if (!fs.existsSync(claudeDir)) {
            fs.mkdirSync(claudeDir, { recursive: true });
        }

        const config = generateClaudeConfig(backendUrl, apiKey, useMCP, mcpServerPath);
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

        return configFile;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write Claude config to ${configFile}: ${message}`);
    }
}


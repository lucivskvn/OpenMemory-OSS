import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMcpPath } from '../utils/mcp';

export interface AntigravityConfig {
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
 * Generates an Antigravity (Gemini) configuration object for OpenMemory integration.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Configuration object for Antigravity
 */
export function generateAntigravityConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): AntigravityConfig {
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

    const config: AntigravityConfig = {
        provider: 'http',
        base_url: `${backendUrl}/api/ide/context`
    };
    if (apiKey) config.api_key = apiKey;
    return config;
}

/**
 * Writes the OpenMemory configuration file for Antigravity (Gemini).
 * Creates the necessary directories if they don't exist.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Path to the created configuration file
 * @throws Error if the configuration cannot be written (e.g., permission denied)
 */
export function writeAntigravityConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): string {
    // Antigravity uses ~/.gemini for configuration (similar to other Google tools)
    const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity', 'providers');
    const configFile = path.join(antigravityDir, 'openmemory.json');

    try {
        if (!fs.existsSync(antigravityDir)) {
            fs.mkdirSync(antigravityDir, { recursive: true });
        }

        const config = generateAntigravityConfig(backendUrl, apiKey, useMCP, mcpServerPath);
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

        return configFile;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write Antigravity config to ${configFile}: ${message}`);
    }
}


import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMcpPath } from '../utils/mcp';

export interface CodexConfig {
    contextProviders?: {
        openmemory: {
            enabled: boolean;
            endpoint: string;
            method: string;
            headers: Record<string, string>;
            queryField: string;
        };
    };
    mcpServers?: {
        openmemory: {
            command: string;
            args: string[];
            env?: Record<string, string>;
        };
    };
}

/**
 * Generates a Codex CLI configuration object for OpenMemory integration.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Configuration object for Codex CLI
 */
export function generateCodexConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): CodexConfig {
    if (useMCP) {
        const backendMcpPath = resolveMcpPath(mcpServerPath);
        const config: CodexConfig = {
            mcpServers: {
                openmemory: {
                    command: 'node',
                    args: [backendMcpPath]
                }
            }
        };
        if (apiKey) {
            config.mcpServers!.openmemory.env = { OM_API_KEY: apiKey };
        }
        return config;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    return {
        contextProviders: {
            openmemory: {
                enabled: true,
                endpoint: `${backendUrl}/api/ide/context`,
                method: 'POST',
                headers,
                queryField: 'query'
            }
        }
    };
}

/**
 * Writes the OpenMemory configuration file for Codex CLI.
 * Creates the necessary directories if they don't exist.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Path to the created configuration file
 * @throws Error if the configuration cannot be written (e.g., permission denied)
 */
export function writeCodexConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): string {
    const codexDir = path.join(os.homedir(), '.codex');
    const configFile = path.join(codexDir, 'context.json');

    try {
        if (!fs.existsSync(codexDir)) {
            fs.mkdirSync(codexDir, { recursive: true });
        }

        const config = generateCodexConfig(backendUrl, apiKey, useMCP, mcpServerPath);
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

        return configFile;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write Codex config to ${configFile}: ${message}`);
    }
}


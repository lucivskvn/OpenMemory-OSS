import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMcpPath } from '../utils/mcp';

export interface WindsurfConfig {
    contextProvider?: string;
    api?: string;
    apiKey?: string;
    mcp?: {
        configPath: string;
    };
}

/**
 * Generates a Windsurf IDE configuration object for OpenMemory integration.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Configuration object for Windsurf
 */
export function generateWindsurfConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): WindsurfConfig {
    if (useMCP) {
        const backendMcpPath = resolveMcpPath(mcpServerPath);
        return {
            contextProvider: 'openmemory-mcp',
            mcp: {
                configPath: backendMcpPath
            }
        };
    }

    const config: WindsurfConfig = {
        contextProvider: 'openmemory',
        api: `${backendUrl}/api/ide/context`
    };
    if (apiKey) config.apiKey = apiKey;
    return config;
}

/**
 * Writes the OpenMemory configuration file for Windsurf IDE.
 * Creates the necessary directories if they don't exist.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Path to the created configuration file
 * @throws Error if the configuration cannot be written (e.g., permission denied)
 */
export function writeWindsurfConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): string {
    const windsurfDir = path.join(os.homedir(), '.windsurf', 'context');
    const configFile = path.join(windsurfDir, 'openmemory.json');

    try {
        if (!fs.existsSync(windsurfDir)) {
            fs.mkdirSync(windsurfDir, { recursive: true });
        }

        const config = generateWindsurfConfig(backendUrl, apiKey, useMCP, mcpServerPath);
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

        return configFile;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write Windsurf config to ${configFile}: ${message}`);
    }
}


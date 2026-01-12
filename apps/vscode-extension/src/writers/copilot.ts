import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMcpPath } from '../utils/mcp';

export interface CopilotConfig {
    name: string;
    type: string;
    endpoint?: string;
    authentication?: {
        type: string;
        header: string;
    };
    mcpServer?: {
        command: string;
        args: string[];
        env?: Record<string, string>;
    };
}

/**
 * Generates a GitHub Copilot configuration object for OpenMemory integration.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Configuration object for GitHub Copilot
 */
export function generateCopilotConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): CopilotConfig {
    if (useMCP) {
        const backendMcpPath = resolveMcpPath(mcpServerPath);
        const config: CopilotConfig = {
            name: 'OpenMemory',
            type: 'mcp',
            mcpServer: {
                command: 'node',
                args: [backendMcpPath]
            }
        };
        if (apiKey) {
            config.mcpServer!.env = { OM_API_KEY: apiKey };
        }
        return config;
    }

    const config: CopilotConfig = {
        name: 'OpenMemory',
        type: 'context_provider',
        endpoint: `${backendUrl}/api/ide/context`
    };

    if (apiKey) {
        config.authentication = {
            type: 'header',
            header: `x-api-key: ${apiKey}`
        };
    }

    return config;
}

/**
 * Writes the OpenMemory configuration file for GitHub Copilot.
 * Creates the necessary directories if they don't exist.
 * @param backendUrl URL of the OpenMemory backend server
 * @param apiKey Optional API key for authentication
 * @param useMCP Whether to use MCP protocol instead of direct HTTP
 * @param mcpServerPath Optional custom path to MCP server executable
 * @returns Path to the created configuration file
 * @throws Error if the configuration cannot be written (e.g., permission denied)
 */
export function writeCopilotConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): string {
    const copilotDir = path.join(os.homedir(), '.github', 'copilot');
    const configFile = path.join(copilotDir, 'openmemory.json');

    try {
        if (!fs.existsSync(copilotDir)) {
            fs.mkdirSync(copilotDir, { recursive: true });
        }

        const config = generateCopilotConfig(backendUrl, apiKey, useMCP, mcpServerPath);
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

        return configFile;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to write Copilot config to ${configFile}: ${message}`);
    }
}


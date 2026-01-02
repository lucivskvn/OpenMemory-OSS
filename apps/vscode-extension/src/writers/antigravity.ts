import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

export function generateAntigravityConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): AntigravityConfig {
    if (useMCP) {
        const backendMcpPath = mcpServerPath || path.join(process.cwd(), 'backend', 'dist', 'ai', 'mcp.js');
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

export async function writeAntigravityConfig(backendUrl: string, apiKey?: string, useMCP = false, mcpServerPath?: string): Promise<string> {
    // Antigravity uses ~/.gemini for configuration (similar to other Google tools)
    const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity', 'providers');
    const configFile = path.join(antigravityDir, 'openmemory.json');

    if (!fs.existsSync(antigravityDir)) {
        fs.mkdirSync(antigravityDir, { recursive: true });
    }

    const config = generateAntigravityConfig(backendUrl, apiKey, useMCP, mcpServerPath);
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    return configFile;
}

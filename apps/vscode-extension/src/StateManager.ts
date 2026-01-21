import * as vscode from 'vscode';
import { MemoryClient } from 'openmemory-js/client';

export interface ExtensionState {
    isEnabled: boolean;
    isTracking: boolean;
    useMcp: boolean;
    backendUrl: string;
    apiKey?: string;
    mcpServerPath: string;
    userId: string;
    sessionId: string | null;
}

export class StateManager {
    private static instance: StateManager;
    private state: ExtensionState;
    public client: MemoryClient;
    public fileCache: Map<string, string>;

    private constructor(private context: vscode.ExtensionContext) {
        this.state = this.getInitialState(context);
        this.client = new MemoryClient({
            baseUrl: this.state.backendUrl,
            token: this.state.apiKey,
            defaultUser: this.state.userId
        });
        this.fileCache = new Map<string, string>();
    }

    private getInitialState(context: vscode.ExtensionContext): ExtensionState {
        const config = vscode.workspace.getConfiguration('openmemory');
        const userId = this.getUserId(context, config);

        return {
            isEnabled: config.get('enabled') ?? true,
            isTracking: false,
            useMcp: config.get('useMCP') || false,
            backendUrl: config.get('backendUrl') || 'http://localhost:8080',
            apiKey: undefined, // Loaded asynchronously
            mcpServerPath: config.get('mcpServerPath') || '',
            userId,
            sessionId: null
        };
    }

    public static getInstance(context?: vscode.ExtensionContext): StateManager {
        if (!StateManager.instance && context) {
            StateManager.instance = new StateManager(context);
        }
        return StateManager.instance;
    }

    public async initialize(): Promise<void> {
        const secretKey = await this.context.secrets.get('openmemory.apiKey');
        if (secretKey) {
            this.updateState({ apiKey: secretKey });
        }
        // Also check legacy config for migration (optional, but good DX)
        const legacyKey = vscode.workspace.getConfiguration('openmemory').get<string>('apiKey');
        if (legacyKey && !secretKey) {
            await this.storeApiKey(legacyKey);
            // Optional: clear legacy config?
        }
    }

    public async storeApiKey(key: string | undefined): Promise<void> {
        if (key) {
            await this.context.secrets.store('openmemory.apiKey', key);
            this.updateState({ apiKey: key });
        } else {
            await this.context.secrets.delete('openmemory.apiKey');
            this.updateState({ apiKey: undefined });
        }
    }

    public getState(): ExtensionState {
        return { ...this.state };
    }

    public updateState(updates: Partial<ExtensionState>) {
        this.state = { ...this.state, ...updates };
        if (updates.backendUrl || updates.apiKey || updates.userId) {
            this.client = new MemoryClient({
                baseUrl: this.state.backendUrl,
                token: this.state.apiKey,
                defaultUser: this.state.userId
            });
        }
    }

    private getUserId(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration): string {
        const configuredUserId = config.get<string>('userId');
        if (configuredUserId) return configuredUserId;

        let persistedUserId = context.globalState.get<string>('openmemory.userId');
        if (persistedUserId) return persistedUserId;

        const machineId = vscode.env.machineId;
        const userName = process.env.USERNAME || process.env.USER || 'user';
        persistedUserId = `${userName}-${machineId.substring(0, 8)}`;

        context.globalState.update('openmemory.userId', persistedUserId);

        return persistedUserId;
    }
}

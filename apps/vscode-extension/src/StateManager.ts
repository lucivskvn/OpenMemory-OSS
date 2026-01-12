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

    private constructor(context: vscode.ExtensionContext) {
        const config = vscode.workspace.getConfiguration('openmemory');
        const userId = this.getUserId(context, config);

        this.state = {
            isEnabled: config.get('enabled') ?? true,
            isTracking: false,
            useMcp: config.get('useMCP') || false,
            backendUrl: config.get('backendUrl') || 'http://localhost:8080',
            apiKey: config.get('apiKey') || undefined,
            mcpServerPath: config.get('mcpServerPath') || '',
            userId,
            sessionId: null
        };

        this.client = new MemoryClient({
            baseUrl: this.state.backendUrl,
            token: this.state.apiKey,
            defaultUser: this.state.userId
        });

        this.fileCache = new Map<string, string>();
    }

    public static getInstance(context?: vscode.ExtensionContext): StateManager {
        if (!StateManager.instance && context) {
            StateManager.instance = new StateManager(context);
        }
        return StateManager.instance;
    }

    public getState(): ExtensionState {
        return { ...this.state };
    }

    public updateState(updates: Partial<ExtensionState>) {
        this.state = { ...this.state, ...updates };
        // Re-init client if auth/url changes
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

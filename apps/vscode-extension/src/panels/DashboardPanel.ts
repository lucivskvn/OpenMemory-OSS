import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { MemoryClient, SystemStats } from 'openmemory-js/client';
import { getBackendInfo } from '../detectors/openmemory';

/**
 * Supported messages from the webview.
 */
type WebviewMessage =
    | { command: 'refresh' }
    | { command: 'quickNote' }
    | { command: 'query' }
    | { command: 'patterns' }
    | { command: 'settings' };

/**
 * Manages the OpenMemory Dashboard webview panel.
 */
export class DashboardPanel {
    public static currentPanel: DashboardPanel | undefined;
    private _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _client: MemoryClient;
    private _disposables: vscode.Disposable[] = [];
    private _stats: SystemStats | null = null;
    private _backendInfo: { version?: string; status?: string } | null = null;

    /**
     * Creates or shows the dashboard panel.
     * @param extensionUri The URI of the extension.
     */
    public static createOrShow(extensionUri: vscode.Uri, client: MemoryClient) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'openMemoryDashboard',
            'OpenMemory Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(path.join(extensionUri.fsPath, 'media'))]
            }
        );

        DashboardPanel.currentPanel = new DashboardPanel(panel, extensionUri, client);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, client: MemoryClient) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._client = client;

        this._update();
        this._fetchStats();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message: WebviewMessage) => {
                switch (message.command) {
                    case 'refresh':
                        await this._fetchStats();
                        return;
                    case 'quickNote':
                        vscode.commands.executeCommand('openmemory.quickNote');
                        return;
                    case 'query':
                        vscode.commands.executeCommand('openmemory.queryContext');
                        return;
                    case 'patterns':
                        vscode.commands.executeCommand('openmemory.viewPatterns');
                        return;
                    case 'settings':
                        vscode.commands.executeCommand('openmemory.setup');
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * Disposes the panel resources.
     */
    public dispose() {
        DashboardPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private async _fetchStats() {
        try {
            // Fetch both stats and backend info in parallel
            const [stats, backendInfo] = await Promise.all([
                this._client.getStats(),
                getBackendInfo(this._client.apiBaseUrl)
            ]);
            this._stats = stats;
            this._backendInfo = backendInfo;
            this._update();
        } catch (e) {
            console.error('Failed to fetch dashboard stats:', e);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Use crypto for secure nonce generation
        const nonce = crypto.randomBytes(32).toString('hex');

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>OpenMemory Dashboard</title>
                <style>
                    body {
                        font-family: var(--vscode-font-family);
                        padding: 20px;
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    h1, h2 {
                        color: var(--vscode-editor-foreground);
                    }
                    .card {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        padding: 15px;
                        border-radius: 5px;
                        margin-bottom: 15px;
                    }
                    .button-group {
                        display: flex;
                        gap: 10px;
                        flex-wrap: wrap;
                    }
                    button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 12px;
                        cursor: pointer;
                        border-radius: 2px;
                    }
                    button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .status-indicator {
                        display: inline-block;
                        width: 10px;
                        height: 10px;
                        border-radius: 50%;
                        background-color: #4caf50;
                        margin-right: 5px;
                    }
                    .stats-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
                        gap: 10px;
                        margin-top: 10px;
                    }
                    .stat-item {
                        text-align: center;
                        padding: 10px;
                        background: rgba(255,255,255,0.05);
                        border-radius: 4px;
                    }
                    .stat-value {
                        font-size: 1.2rem;
                        font-weight: bold;
                        display: block;
                    }
                    .stat-label {
                        font-size: 0.7rem;
                        opacity: 0.7;
                    }
                </style>
            </head>
            <body>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <h1>OpenMemory Dashboard</h1>
                    <button onclick="sendMessage('refresh')">🔄 Refresh</button>
                </div>
                
                <div class="card">
                    <h2>System Status</h2>
                    <p><span class="status-indicator"></span> ${this._stats ? 'Connected' : 'Connecting...'}${this._backendInfo?.version ? ` (v${this._backendInfo.version})` : ''}</p>
                    
                    ${this._stats ? `
                    <div class="stats-grid">
                        <div class="stat-item">
                            <span class="stat-value">${this._stats.totalMemories}</span>
                            <span class="stat-label">Total Memories</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">${this._stats.sectorCounts?.semantic || 0}</span>
                            <span class="stat-label">Semantic Node</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">${this._stats.system?.uptime ? (this._stats.system.uptime.seconds / 3600).toFixed(1) : 0}h</span>
                            <span class="stat-label">Uptime</span>
                        </div>
                    </div>
                    ` : '<p>Loading system metrics...</p>'}
                </div>

                <div class="card">
                    <h2>Quick Actions</h2>
                    <div class="button-group">
                        <button onclick="sendMessage('quickNote')">📝 Quick Note</button>
                        <button onclick="sendMessage('query')">🔍 Query Context</button>
                        <button onclick="sendMessage('patterns')">📊 View Patterns</button>
                        <button onclick="sendMessage('settings')">⚙️ Settings</button>
                    </div>
                </div>

                <div class="card">
                    <h2>Recent Activity</h2>
                    <p>Tracking your coding session...</p>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    function sendMessage(command) {
                        vscode.postMessage({ command: command });
                    }
                </script>
            </body>
            </html>`;
    }
}

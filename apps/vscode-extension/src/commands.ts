import * as vscode from 'vscode';
import * as path from 'path';
import { StateManager } from './StateManager';
import { UIService } from './UIService';
import { DisplayMemory } from './types';
import { IdePattern } from 'openmemory-js/client';
import { writeCursorConfig } from './writers/cursor';
import { writeClaudeConfig } from './writers/claude';
import { writeWindsurfConfig } from './writers/windsurf';
import { writeCopilotConfig } from './writers/copilot';
import { writeCodexConfig } from './writers/codex';
import { writeAntigravityConfig } from './writers/antigravity';
import { DashboardPanel } from './panels/DashboardPanel';

export class CommandController {
    constructor(
        private context: vscode.ExtensionContext,
        private stateManager: StateManager,
        private uiService: UIService
    ) { }

    async showMenu() {
        const { isEnabled, isTracking, useMcp, sessionId } = this.stateManager.getState();

        if (!isEnabled) {
            const choice = await vscode.window.showQuickPick([
                { label: '$(check) Enable OpenMemory', action: 'enable' },
                { label: '$(gear) Setup', action: 'setup' }
            ], { placeHolder: 'OpenMemory is Disabled' });
            if (!choice) return;
            if (choice.action === 'enable') {
                const config = vscode.workspace.getConfiguration('openmemory');
                await config.update('enabled', true, vscode.ConfigurationTarget.Global);
                this.stateManager.updateState({ isEnabled: true });
                vscode.window.showInformationMessage('OpenMemory enabled. Reloading window...');
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else if (choice.action === 'setup') {
                this.showQuickSetup();
            }
            return;
        }

        const items = [];
        items.push(isTracking ? { label: '$(debug-pause) Pause Tracking', action: 'pause' } : { label: '$(play) Resume Tracking', action: 'resume' });
        items.push({ label: '$(dashboard) Open Dashboard', action: 'dashboard' });
        items.push({ label: '$(search) Query Context', action: 'query' }, { label: '$(add) Add Selection', action: 'add' }, { label: '$(pencil) Quick Note', action: 'note' }, { label: '$(graph) View Patterns', action: 'patterns' }, { label: useMcp ? '$(link) Switch to Direct HTTP' : '$(server-process) Switch to MCP Mode', action: 'toggle_mcp' }, { label: '$(circle-slash) Disable Extension', action: 'disable' }, { label: '$(gear) Setup', action: 'setup' }, { label: '$(refresh) Reconnect', action: 'reconnect' });
        const choice = await vscode.window.showQuickPick(items, { placeHolder: 'OpenMemory Actions' });
        if (!choice) return;
        switch (choice.action) {
            case 'dashboard': this.openDashboard(); break;
            case 'pause':
                this.stateManager.updateState({ isTracking: false });
                this.uiService.update('paused');
                break;
            case 'resume':
                this.stateManager.updateState({ isTracking: true });
                this.uiService.update('active');
                break;
            case 'query': this.queryContextCmd(); break;
            case 'add': this.addToMemoryCmd(); break;
            case 'note': this.quickNoteCmd(); break;
            case 'patterns': this.viewPatternsCmd(); break;
            case 'toggle_mcp': {
                const newMcp = !useMcp;
                const mcpConfig = vscode.workspace.getConfiguration('openmemory');
                await mcpConfig.update('useMCP', newMcp, vscode.ConfigurationTarget.Global);
                this.stateManager.updateState({ useMcp: newMcp });
                vscode.window.showInformationMessage(`Switched to ${newMcp ? 'MCP' : 'Direct HTTP'} mode. Reconnecting...`);
                await this.autoLinkAll();
                break;
            }
            case 'disable': {
                const config = vscode.workspace.getConfiguration('openmemory');
                await config.update('enabled', false, vscode.ConfigurationTarget.Global);
                this.stateManager.updateState({ isEnabled: false });
                if (sessionId) {
                    const { userId } = this.stateManager.getState();
                    await this.stateManager.client.endIdeSession(sessionId, userId);
                }
                this.uiService.update('disabled');
                vscode.window.showInformationMessage('OpenMemory disabled');
                break;
            }
            case 'setup': this.showQuickSetup(); break;
            case 'reconnect': {
                this.uiService.update('connecting');
                const connected = await this.checkConnection();
                if (connected) {
                    await this.startSession();
                    vscode.window.showInformationMessage('✅ Connected successfully');
                } else {
                    this.uiService.update('disconnected');
                    vscode.window.showErrorMessage('❌ Connection failed');
                }
                break;
            }
        }
    }

    async showQuickSetup() {
        const { isEnabled, useMcp, mcpServerPath, backendUrl } = this.stateManager.getState();
        const items = [
            { label: isEnabled ? '$(circle-slash) Disable Extension' : '$(check) Enable Extension', action: 'toggle_enabled', description: isEnabled ? 'Turn off OpenMemory tracking' : 'Turn on OpenMemory tracking' },
            { label: '$(server-process) Toggle MCP Mode', action: 'mcp', description: useMcp ? 'Currently: MCP (switch to Direct HTTP)' : 'Currently: Direct HTTP (switch to MCP)' },
            { label: '$(key) Configure API Key', action: 'apikey' },
            { label: '$(server) Change Backend URL', action: 'url' },
            { label: '$(file-code) Set MCP Server Path', action: 'mcppath', description: 'Optional: custom MCP server executable' },
            { label: '$(link-external) View Documentation', action: 'docs' },
            { label: '$(debug-restart) Test Connection', action: 'test' }
        ];
        const choice = await vscode.window.showQuickPick(items, { placeHolder: 'OpenMemory Setup' });
        if (!choice) return;

        const config = vscode.workspace.getConfiguration('openmemory');

        switch (choice.action) {
            case 'toggle_enabled': {
                const newEnabled = !isEnabled;
                await config.update('enabled', newEnabled, vscode.ConfigurationTarget.Global);
                this.stateManager.updateState({ isEnabled: newEnabled });
                if (newEnabled) {
                    vscode.window.showInformationMessage('OpenMemory enabled. Reloading window...');
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                } else {
                    const { sessionId } = this.stateManager.getState();
                    // Note: Deactivate logic is usually at extension level, but we can simulate session end
                    if (sessionId) {
                        const { userId } = this.stateManager.getState();
                        await this.stateManager.client.endIdeSession(sessionId, userId);
                        this.stateManager.updateState({ sessionId: null });
                    }
                    this.uiService.update('disabled');
                    vscode.window.showInformationMessage('OpenMemory disabled');
                }
                break;
            }
            case 'mcp': {
                const newMcp = !useMcp;
                await config.update('useMCP', newMcp, vscode.ConfigurationTarget.Global);
                this.stateManager.updateState({ useMcp: newMcp });
                vscode.window.showInformationMessage(`Switched to ${newMcp ? 'MCP' : 'Direct HTTP'} mode`);
                await this.autoLinkAll();
                break;
            }
            case 'mcppath': {
                const path = await vscode.window.showInputBox({
                    prompt: 'Enter MCP server executable path (leave empty to use backend MCP)',
                    value: mcpServerPath,
                    placeHolder: '/path/to/mcp-server'
                });
                if (path !== undefined) {
                    await config.update('mcpServerPath', path, vscode.ConfigurationTarget.Global);
                    this.stateManager.updateState({ mcpServerPath: path });
                    vscode.window.showInformationMessage('MCP server path updated');
                }
                break;
            }
            case 'apikey': {
                const key = await vscode.window.showInputBox({
                    prompt: 'Enter API key (leave empty if not required)',
                    password: true,
                    placeHolder: 'your-api-key'
                });
                if (key !== undefined) {
                    await this.stateManager.storeApiKey(key);
                    vscode.window.showInformationMessage('API key saved safely');
                    if (await this.checkConnection()) await this.startSession();
                    break;
                }
            case 'url': {
                const url = await vscode.window.showInputBox({
                    prompt: 'Enter backend URL',
                    value: backendUrl,
                    placeHolder: 'http://localhost:8080'
                });
                if (url) {
                    await config.update('backendUrl', url, vscode.ConfigurationTarget.Global);
                    this.stateManager.updateState({ backendUrl: url });
                    vscode.window.showInformationMessage('Backend URL updated');
                    if (await this.checkConnection()) await this.startSession();
                }
                break;
            }
            case 'docs': vscode.env.openExternal(vscode.Uri.parse('https://github.com/CaviraOSS/OpenMemory')); break;
            case 'test':
                this.uiService.update('connecting');
                if (await this.checkConnection()) {
                    await this.startSession();
                    vscode.window.showInformationMessage('✅ Connected successfully');
                } else {
                    this.uiService.update('disconnected');
                    vscode.window.showErrorMessage('❌ Connection failed');
                }
                break;
        }
    }

    async autoLinkAll() {
        const { backendUrl, apiKey, useMcp, mcpServerPath } = this.stateManager.getState();
        const results: { name: string; success: boolean; error?: string }[] = [];

        const tryLink = async (name: string, fn: () => string | Promise<string>) => {
            try {
                await Promise.resolve(fn());
                results.push({ name, success: true });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                results.push({ name, success: false, error: msg });
            }
        };

        await tryLink('Cursor', () => writeCursorConfig(backendUrl, apiKey, useMcp, mcpServerPath));
        await tryLink('Claude Desktop', () => writeClaudeConfig(backendUrl, apiKey, useMcp, mcpServerPath));
        await tryLink('Windsurf', () => writeWindsurfConfig(backendUrl, apiKey, useMcp, mcpServerPath));
        await tryLink('Copilot', () => writeCopilotConfig(backendUrl, apiKey, useMcp, mcpServerPath));
        await tryLink('Codex', () => writeCodexConfig(backendUrl, apiKey, useMcp, mcpServerPath));
        await tryLink('Antigravity', () => writeAntigravityConfig(backendUrl, apiKey, useMcp, mcpServerPath));

        const failures = results.filter(r => !r.success);
        const mode = useMcp ? 'MCP protocol' : 'Direct HTTP';

        if (failures.length === 0) {
            console.log(`✅ Auto-linked OpenMemory to all AI tools (${mode})`);
        } else if (failures.length === results.length) {
            vscode.window.showErrorMessage(`❌ Auto-link failed for all tools! Check permissions and logs.`);
        } else {
            const failedNames = failures.map(r => r.name).join(', ');
            console.warn(`⚠️ OpenMemory partial auto-link failure: ${failedNames}`);
        }
    }

    async checkConnection(): Promise<boolean> {
        try {
            const health = await this.stateManager.client.health();
            return health === true;
        } catch {
            return false;
        }
    }

    async startSession() {
        try {
            const config = vscode.workspace.getConfiguration('openmemory');
            const configuredProject = config.get<string>('projectName');
            const project = configuredProject || vscode.workspace.workspaceFolders?.[0]?.name || 'unknown';
            const { userId } = this.stateManager.getState();

            const data = await this.stateManager.client.startIdeSession({
                userId,
                projectName: project,
                ideName: 'vscode'
            });

            this.stateManager.updateState({ sessionId: data.sessionId, isTracking: true });
            this.uiService.update('active');
            vscode.window.showInformationMessage('OpenMemory connected');
        } catch (e) {
            console.error('OpenMemory Session Start Failed:', e);
            this.uiService.update('disconnected');
            this.showQuickSetup();
        }
    }

    openDashboard() {
        DashboardPanel.createOrShow(this.context.extensionUri, this.stateManager.client);
    }

    async queryContextCmd() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "OpenMemory: Querying Context...",
            cancellable: false
        }, async () => {
            try {
                const query = editor.document.getText(editor.selection) || editor.document.getText();
                // Logic extracted from queryContext function
                const { sessionId } = this.stateManager.getState();
                const data = await this.stateManager.client.getIdeContext(query, {
                    sessionId: sessionId || undefined,
                    filePath: editor.document.uri.fsPath,
                    k: 10
                });

                const memories: DisplayMemory[] = (data.context || []).map((c) => ({
                    id: c.memoryId,
                    content: c.content,
                    salience: c.salience,
                    primarySector: c.primarySector,
                    metadata: {
                        score: c.score,
                        sectors: c.sectors,
                        lastSeenAt: c.lastSeenAt,
                        path: c.path
                    }
                }));

                const doc = await vscode.workspace.openTextDocument({ content: this.formatMemories(memories), language: 'markdown' });
                await vscode.window.showTextDocument(doc);
            } catch (error) {
                vscode.window.showErrorMessage(`Query failed: ${error}`);
            }
        });
    }

    async addToMemoryCmd() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showErrorMessage('No text selected');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "OpenMemory: Saving Selection...",
            cancellable: false
        }, async () => {
            try {
                const { userId } = this.stateManager.getState();
                await this.stateManager.client.add(selection, {
                    userId,
                    tags: ['manual', 'ide-selection'],
                    metadata: { source: 'vscode', file: editor.document.uri.fsPath }
                });
                vscode.window.showInformationMessage('Selection added to OpenMemory');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add memory: ${error}`);
            }
        });
    }

    async quickNoteCmd() {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter a quick note to remember',
            placeHolder: 'e.g. Refactored the auth logic to use JWT'
        });

        if (!input) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "OpenMemory: Saving Note...",
            cancellable: false
        }, async () => {
            try {
                await this.ingestData(input, 'quick_note', {
                    timestamp: Date.now(),
                    type: 'quick_note'
                });
                vscode.window.showInformationMessage('Note saved to OpenMemory');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to save note: ${error}`);
            }
        });
    }

    async viewPatternsCmd() {
        const { sessionId } = this.stateManager.getState();
        if (!sessionId) {
            vscode.window.showErrorMessage('No active session');
            return;
        }
        try {
            const data = await this.stateManager.client.getIdePatterns(sessionId);
            const patterns = data.patterns || [];
            const doc = await vscode.workspace.openTextDocument({ content: this.formatPatterns(patterns), language: 'markdown' });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed: ${error}`);
        }
    }

    async ingestItemCmd(uri: vscode.Uri) {
        if (!uri) {
            const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: true, openLabel: 'Ingest' });
            if (folder && folder[0]) uri = folder[0];
            else return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `OpenMemory: Ingesting ${path.basename(uri.fsPath)}...`,
            cancellable: false
        }, async () => {
            try {
                // Determine if it's a file or folder
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.Directory) {
                    await this.ingestPath(uri.fsPath);
                } else {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await this.ingestData(doc.getText(), 'file', { filePath: uri.fsPath });
                }
                vscode.window.showInformationMessage('Ingestion complete');
            } catch (error) {
                vscode.window.showErrorMessage(`Ingestion failed: ${error}`);
            }
        });
    }

    async sendEvent(payload: {
        eventType: string;
        filePath: string;
        content: string;
        language?: string;
        metadata?: any;
    }) {
        const { sessionId, userId } = this.stateManager.getState();
        if (!sessionId) return;
        try {
            await this.stateManager.client.sendIdeEvent({
                sessionId,
                eventType: payload.eventType,
                filePath: payload.filePath,
                content: payload.content,
                userId,
                metadata: {
                    ...payload.metadata,
                    language: payload.language
                }
            });
        } catch (e) {
            console.error("Failed to send event:", e);
        }
    }

    // --- Helpers ---

    private formatMemories(memories: DisplayMemory[]): string {
        let out = '# OpenMemory Context Results\n\n';
        if (memories.length === 0) return out + 'No relevant memories found.\n';
        for (const m of memories) {
            const salience = m.salience ? m.salience.toFixed(3) : 'N/A';
            const sector = m.primarySector || 'semantic';
            out += `## Memory ID: ${m.id}\n**Salience:** ${salience}\n**Sector:** ${sector}\n**Content:**\n\`\`\`\n${m.content}\n\`\`\`\n\n`;
        }
        return out;
    }

    private formatPatterns(patterns: IdePattern[]): string {
        let out = '# Detected Coding Patterns\n\n';
        if (patterns.length === 0) return out + 'No patterns detected.\n';
        for (const p of patterns) {
            out += `## Pattern: ${p.description || 'Unknown'}\n**Confidence:** ${p.confidence ? (p.confidence * 100).toFixed(1) : 'N/A'}%\n**Files:** ${p.affectedFiles?.join(', ') || 'N/A'}\n\n`;
        }
        return out;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async ingestData(content: string, type: string, extraMeta: any = {}) {
        const { userId } = this.stateManager.getState();
        await this.stateManager.client.ingest({
            source: "connector",
            contentType: "txt",
            data: content,
            metadata: {
                ...extraMeta,
                origin: "vscode-quick-note",
                ideUserId: userId
            }
        });
    }

    private async ingestPath(dirPath: string) {
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(dirPath, '**/*'));
        for (const file of files) {
            try {
                const stat = await vscode.workspace.fs.stat(file);
                if (stat.size > 5 * 1024 * 1024) continue; // Skip large files > 5MB

                const content = await vscode.workspace.fs.readFile(file);
                await this.ingestData(Buffer.from(content).toString('utf-8'), 'file', { filePath: file.fsPath });
            } catch (e) {
                console.warn(`Failed to ingest ${file.fsPath}:`, e);
            }
        }
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import { writeCursorConfig } from './writers/cursor';
import { writeClaudeConfig } from './writers/claude';
import { writeWindsurfConfig } from './writers/windsurf';
import { writeCopilotConfig } from './writers/copilot';
import { writeCodexConfig } from './writers/codex';
import { writeAntigravityConfig } from './writers/antigravity';
import { DashboardPanel } from './panels/DashboardPanel';
import { generateDiff } from './utils/diff';
import { shouldSkipEvent, getSectorFilter } from './hooks/ideEvents';
import { MemoryItem, IdePattern } from 'openmemory-js/client';
import { StateManager } from './StateManager';
import { UIService } from './UIService';

let stateManager: StateManager;
let uiService: UIService;

/**
 * Activates the OpenMemory extension.
 * @param context VS Code extension context
 */
export function activate(context: vscode.ExtensionContext) {
    stateManager = StateManager.getInstance(context);
    uiService = new UIService(context, stateManager);

    const { isEnabled } = stateManager.getState();
    const statusClick = vscode.commands.registerCommand('openmemory.statusBarClick', () => showMenu());

    if (!isEnabled) {
        uiService.update('disabled');
        context.subscriptions.push(statusClick);
        return;
    }

    uiService.update('connecting');

    checkConnection().then(async connected => {
        if (connected) {
            await autoLinkAll();
            await startSession();
        } else {
            uiService.update('disconnected');
            showQuickSetup();
        }
    });

    // --- Commands ---

    const queryCmd = vscode.commands.registerCommand('openmemory.queryContext', async () => {
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
                const memories = await queryContext(query, editor.document.uri.fsPath);
                const doc = await vscode.workspace.openTextDocument({ content: formatMemories(memories), language: 'markdown' });
                await vscode.window.showTextDocument(doc);
            } catch (error) {
                vscode.window.showErrorMessage(`Query failed: ${error}`);
            }
        });
    });

    const addCmd = vscode.commands.registerCommand('openmemory.addToMemory', async () => {
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
                await addMemory(selection, editor.document.uri.fsPath);
                vscode.window.showInformationMessage('Selection added to OpenMemory');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to add memory: ${error}`);
            }
        });
    });

    const noteCmd = vscode.commands.registerCommand('openmemory.quickNote', async () => {
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
                await ingestData(input, 'quick_note', {
                    timestamp: Date.now(),
                    type: 'quick_note'
                });
                vscode.window.showInformationMessage('Note saved to OpenMemory');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to save note: ${error}`);
            }
        });
    });

    const patternsCmd = vscode.commands.registerCommand('openmemory.viewPatterns', async () => {
        const { sessionId } = stateManager.getState();
        if (!sessionId) {
            vscode.window.showErrorMessage('No active session');
            return;
        }
        try {
            const patterns = await getPatterns(sessionId);
            const doc = await vscode.workspace.openTextDocument({ content: formatPatterns(patterns), language: 'markdown' });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed: ${error}`);
        }
    });

    const toggleCmd = vscode.commands.registerCommand('openmemory.toggleTracking', () => {
        const current = stateManager.getState().isTracking;
        stateManager.updateState({ isTracking: !current });
        uiService.update(stateManager.getState().isTracking ? 'active' : 'paused');
    });

    const setupCmd = vscode.commands.registerCommand('openmemory.setup', () => showQuickSetup());
    const dashboardCmd = vscode.commands.registerCommand('openmemory.dashboard', () => { DashboardPanel.createOrShow(context.extensionUri, stateManager.client); });

    // Initialize cache for all currently open documents
    vscode.workspace.textDocuments.forEach(doc => {
        if (doc.uri.scheme === 'file') {
            stateManager.fileCache.set(doc.uri.toString(), doc.getText());
        }
    });

    const openListener = vscode.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => {
        if (doc.uri.scheme === 'file') {
            stateManager.fileCache.set(doc.uri.toString(), doc.getText());
        }
    });

    const saveListener = vscode.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
        const { isEnabled, isTracking } = stateManager.getState();
        if (isEnabled && isTracking && doc.uri.scheme === 'file') {
            const newContent = doc.getText();
            const oldContent = stateManager.fileCache.get(doc.uri.toString());
            let contentToSend = "";

            if (oldContent) {
                const diff = generateDiff(oldContent, newContent, doc.uri.fsPath);
                contentToSend = diff;
            } else {
                contentToSend = `[New File Snapshot]\n${newContent}`;
            }

            // Deduplicate events to prevent redundant network calls
            if (shouldSkipEvent(doc.uri.fsPath, 'save', contentToSend)) {
                return;
            }

            // Update cache for next save
            stateManager.fileCache.set(doc.uri.toString(), newContent);

            // Get sector hints for better memory classification
            const sectorHints = getSectorFilter('save');

            sendEvent({
                eventType: 'save',
                filePath: doc.uri.fsPath,
                language: doc.languageId,
                content: contentToSend,
                metadata: {
                    lineCount: doc.lineCount,
                    isDirty: doc.isDirty,
                    workspaceFolder: vscode.workspace.getWorkspaceFolder(doc.uri)?.name,
                    sectorHints
                }
            });
        }
    });

    const ingestCmd = vscode.commands.registerCommand('openmemory.ingestItem', async (uri: vscode.Uri) => {
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
                    await ingestPath(uri.fsPath);
                } else {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await ingestData(doc.getText(), 'file', { filePath: uri.fsPath });
                }
                vscode.window.showInformationMessage('Ingestion complete');
            } catch (error) {
                vscode.window.showErrorMessage(`Ingestion failed: ${error}`);
            }
        });
    });

    context.subscriptions.push(statusClick, toggleCmd, setupCmd, dashboardCmd, saveListener, openListener, queryCmd, addCmd, noteCmd, patternsCmd, ingestCmd);
}

/**
 * Deactivates the extension.
 */
export async function deactivate() {
    const { sessionId, userId } = stateManager.getState();
    if (sessionId) {
        try {
            await stateManager.client.endIdeSession(sessionId, userId);
            stateManager.updateState({ sessionId: null });
        } catch (e) {
            console.error('OpenMemory Session End Failed:', e);
        }
    }
}

/**
 * Automatically configures external AI tools to use OpenMemory server.
 */
async function autoLinkAll() {
    const { backendUrl, apiKey, useMcp, mcpServerPath } = stateManager.getState();
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


async function showMenu() {
    const { isEnabled, isTracking, useMcp, sessionId } = stateManager.getState();

    if (!isEnabled) {
        const choice = await vscode.window.showQuickPick([
            { label: '$(check) Enable OpenMemory', action: 'enable' },
            { label: '$(gear) Setup', action: 'setup' }
        ], { placeHolder: 'OpenMemory is Disabled' });
        if (!choice) return;
        if (choice.action === 'enable') {
            const config = vscode.workspace.getConfiguration('openmemory');
            await config.update('enabled', true, vscode.ConfigurationTarget.Global);
            stateManager.updateState({ isEnabled: true });
            vscode.window.showInformationMessage('OpenMemory enabled. Reloading window...');
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        } else if (choice.action === 'setup') {
            showQuickSetup();
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
        case 'dashboard': vscode.commands.executeCommand('openmemory.dashboard'); break;
        case 'pause':
            stateManager.updateState({ isTracking: false });
            uiService.update('paused');
            break;
        case 'resume':
            stateManager.updateState({ isTracking: true });
            uiService.update('active');
            break;
        case 'query': vscode.commands.executeCommand('openmemory.queryContext'); break;
        case 'add': vscode.commands.executeCommand('openmemory.addToMemory'); break;
        case 'note': vscode.commands.executeCommand('openmemory.quickNote'); break;
        case 'patterns': vscode.commands.executeCommand('openmemory.viewPatterns'); break;
        case 'toggle_mcp': {
            const newMcp = !useMcp;
            const mcpConfig = vscode.workspace.getConfiguration('openmemory');
            await mcpConfig.update('useMCP', newMcp, vscode.ConfigurationTarget.Global);
            stateManager.updateState({ useMcp: newMcp });
            vscode.window.showInformationMessage(`Switched to ${newMcp ? 'MCP' : 'Direct HTTP'} mode. Reconnecting...`);
            await autoLinkAll();
            break;
        }
        case 'disable': {
            const config = vscode.workspace.getConfiguration('openmemory');
            await config.update('enabled', false, vscode.ConfigurationTarget.Global);
            stateManager.updateState({ isEnabled: false });
            if (sessionId) {
                const { userId } = stateManager.getState();
                await stateManager.client.endIdeSession(sessionId, userId);
            }
            uiService.update('disabled');
            vscode.window.showInformationMessage('OpenMemory disabled');
            break;
        }
        case 'setup': showQuickSetup(); break;
        case 'reconnect': {
            uiService.update('connecting');
            const connected = await checkConnection();
            if (connected) {
                await startSession();
            } else {
                uiService.update('disconnected');
                vscode.window.showErrorMessage('Cannot connect to backend');
            }
            break;
        }
    }
}

async function showQuickSetup() {
    const { isEnabled, useMcp, mcpServerPath, backendUrl } = stateManager.getState();
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
            stateManager.updateState({ isEnabled: newEnabled });
            if (newEnabled) {
                vscode.window.showInformationMessage('OpenMemory enabled. Reloading window...');
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else {
                const { sessionId } = stateManager.getState();
                if (sessionId) await deactivate();
                uiService.update('disabled');
                vscode.window.showInformationMessage('OpenMemory disabled');
            }
            break;
        }
        case 'mcp': {
            const newMcp = !useMcp;
            await config.update('useMCP', newMcp, vscode.ConfigurationTarget.Global);
            stateManager.updateState({ useMcp: newMcp });
            vscode.window.showInformationMessage(`Switched to ${newMcp ? 'MCP' : 'Direct HTTP'} mode`);
            await autoLinkAll();
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
                stateManager.updateState({ mcpServerPath: path });
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
                await config.update('apiKey', key, vscode.ConfigurationTarget.Global);
                stateManager.updateState({ apiKey: key });
                vscode.window.showInformationMessage('API key saved');
                if (await checkConnection()) await startSession();
            }
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
                stateManager.updateState({ backendUrl: url });
                vscode.window.showInformationMessage('Backend URL updated');
                if (await checkConnection()) await startSession();
            }
            break;
        }
        case 'docs': vscode.env.openExternal(vscode.Uri.parse('https://github.com/CaviraOSS/OpenMemory')); break;
        case 'test':
            uiService.update('connecting');
            if (await checkConnection()) {
                await startSession();
                vscode.window.showInformationMessage('✅ Connected successfully');
            } else {
                uiService.update('disconnected');
                vscode.window.showErrorMessage('❌ Connection failed');
            }
            break;
    }
}

// --- Status Helpers ---

async function checkConnection(): Promise<boolean> {
    try {
        const health = await stateManager.client.health();
        return health === true;
    } catch {
        return false;
    }
}

async function startSession() {
    try {
        const config = vscode.workspace.getConfiguration('openmemory');
        const configuredProject = config.get<string>('projectName');
        const project = configuredProject || vscode.workspace.workspaceFolders?.[0]?.name || 'unknown';
        const { userId } = stateManager.getState();

        const data = await stateManager.client.startIdeSession({
            userId,
            projectName: project,
            ideName: 'vscode'
        });

        stateManager.updateState({ sessionId: data.sessionId, isTracking: true });
        uiService.update('active');
        vscode.window.showInformationMessage('OpenMemory connected');
    } catch (e) {
        console.error('OpenMemory Session Start Failed:', e);
        uiService.update('disconnected');
        showQuickSetup();
    }
}

async function sendEvent(eventData: Record<string, unknown>) {
    const { sessionId, userId, isTracking } = stateManager.getState();
    if (!sessionId || !isTracking) return;
    try {
        await stateManager.client.sendIdeEvent({
            sessionId: sessionId,
            userId: userId,
            eventType: eventData.eventType as string,
            filePath: eventData.filePath as string,
            language: eventData.language as string,
            content: eventData.content as string,
            metadata: eventData.metadata as Record<string, unknown>
        });
    } catch (e) {
        console.error('OpenMemory Event Sending Failed:', e);
    }
}

// Local type for display purposes, avoiding full MemoryItem mocking
interface DisplayMemory {
    id: string;
    content: string;
    salience?: number;
    primarySector?: string;
    metadata?: Record<string, unknown>;
}

async function queryContext(query: string, file: string): Promise<DisplayMemory[]> {
    const { sessionId } = stateManager.getState();
    const data = await stateManager.client.getIdeContext(query, {
        sessionId: sessionId || undefined,
        filePath: file,
        k: 10
    });
    // Map strictly typed IdeContextItem to a shape compatible with DisplayMemory
    return (data.context || []).map((c) => ({
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
}

async function addMemory(content: string, file: string) {
    const { userId } = stateManager.getState();
    return await stateManager.client.add(content, {
        userId,
        tags: ['manual', 'ide-selection'],
        metadata: { source: 'vscode', file }
    });
}

async function getPatterns(sid: string): Promise<IdePattern[]> {
    const data = await stateManager.client.getIdePatterns(sid);
    return data.patterns || [];
}

// --- Formatters ---

function formatMemories(memories: DisplayMemory[]): string {
    let out = '# OpenMemory Context Results\n\n';
    if (memories.length === 0) return out + 'No relevant memories found.\n';
    for (const m of memories) {
        const salience = m.salience ? m.salience.toFixed(3) : 'N/A';
        const sector = m.primarySector || 'semantic';
        out += `## Memory ID: ${m.id}\n**Salience:** ${salience}\n**Sector:** ${sector}\n**Content:**\n\`\`\`\n${m.content}\n\`\`\`\n\n`;
    }
    return out;
}

function formatPatterns(patterns: IdePattern[]): string {
    let out = '# Detected Coding Patterns\n\n';
    if (patterns.length === 0) return out + 'No patterns detected.\n';
    for (const p of patterns) {
        out += `## Pattern: ${p.description || 'Unknown'}\n**Confidence:** ${p.confidence ? (p.confidence * 100).toFixed(1) : 'N/A'}%\n**Files:** ${p.affectedFiles?.join(', ') || 'N/A'}\n\n`;
    }
    return out;
}

// Helper to ingest data
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ingestData(content: string, type: string, extraMeta: any = {}) {
    const { userId } = stateManager.getState();
    await stateManager.client.ingest({
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

// Helper to ingest an entire path
async function ingestPath(dirPath: string) {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(dirPath, '**/*'));
    for (const file of files) {
        try {
            const stat = await vscode.workspace.fs.stat(file);
            if (stat.size > 5 * 1024 * 1024) continue; // Skip large files > 5MB

            const content = await vscode.workspace.fs.readFile(file);
            await ingestData(Buffer.from(content).toString('utf-8'), 'file', { filePath: file.fsPath });
        } catch (e) {
            console.warn(`Failed to ingest ${file.fsPath}:`, e);
        }
    }
}


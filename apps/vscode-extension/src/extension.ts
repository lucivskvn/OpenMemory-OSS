import * as vscode from 'vscode';
import { DashboardPanel } from './panels/DashboardPanel';
import { generateDiff } from './utils/diff';
import { shouldSkipEvent, getSectorFilter } from './hooks/ideEvents';
import { StateManager } from './StateManager';
import { UIService } from './UIService';
import { CommandController } from './commands';

let stateManager: StateManager;
let uiService: UIService;
let commandController: CommandController;

/**
 * Activates the OpenMemory extension.
 * @param context VS Code extension context
 */
export async function activate(context: vscode.ExtensionContext) {
    stateManager = StateManager.getInstance(context);
    await stateManager.initialize();
    uiService = new UIService(context, stateManager);
    commandController = new CommandController(context, stateManager, uiService);

    const { isEnabled } = stateManager.getState();
    const statusClick = vscode.commands.registerCommand('openmemory.statusBarClick', () => commandController.showMenu());

    if (!isEnabled) {
        uiService.update('disabled');
        context.subscriptions.push(statusClick);
        return;
    }

    uiService.update('connecting');

    commandController.checkConnection().then(async connected => {
        if (connected) {
            await commandController.autoLinkAll();
            await commandController.startSession();
        } else {
            uiService.update('disconnected');
            // Allow user to setup if disconnected
            commandController.showQuickSetup();
        }
    });

    // --- Commands ---

    const queryCmd = vscode.commands.registerCommand('openmemory.queryContext', () => commandController.queryContextCmd());
    const addCmd = vscode.commands.registerCommand('openmemory.addToMemory', () => commandController.addToMemoryCmd());
    const noteCmd = vscode.commands.registerCommand('openmemory.quickNote', () => commandController.quickNoteCmd());
    const patternsCmd = vscode.commands.registerCommand('openmemory.viewPatterns', () => commandController.viewPatternsCmd());

    const toggleCmd = vscode.commands.registerCommand('openmemory.toggleTracking', () => {
        const current = stateManager.getState().isTracking;
        stateManager.updateState({ isTracking: !current });
        uiService.update(stateManager.getState().isTracking ? 'active' : 'paused');
    });

    const setupCmd = vscode.commands.registerCommand('openmemory.setup', () => commandController.showQuickSetup());
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

            commandController.sendEvent({
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
        await commandController.ingestItemCmd(uri);
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

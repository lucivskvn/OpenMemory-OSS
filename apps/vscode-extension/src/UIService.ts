import * as vscode from 'vscode';
import { StateManager } from './StateManager';

export class UIService {
    private statusBar: vscode.StatusBarItem;
    private stateManager: StateManager;

    constructor(context: vscode.ExtensionContext, stateManager: StateManager) {
        this.stateManager = stateManager;
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBar.command = 'openmemory.statusBarClick';
        context.subscriptions.push(this.statusBar);
        this.update();
        this.statusBar.show();
    }

    public update(status: 'active' | 'paused' | 'connecting' | 'disconnected' | 'disabled' = 'disconnected') {
        const state = this.stateManager.getState();
        const build = 'B';
        const icons = {
            active: `$(pulse) OpenMemory [${build}]`,
            paused: `$(debug-pause) OpenMemory [${build}]`,
            connecting: `$(sync~spin) OpenMemory [${build}]`,
            disconnected: `$(error) OpenMemory [${build}]`,
            disabled: `$(circle-slash) OpenMemory [${build}]`
        };

        // Override status if disabled
        const finalStatus = !state.isEnabled ? 'disabled' : status;

        const mode = state.useMcp ? 'MCP' : 'HTTP';
        const tooltips = {
            active: `OpenMemory [${build}]: Tracking active (${mode}) • Click for options`,
            paused: `OpenMemory [${build}]: Tracking paused (${mode}) • Click to resume`,
            connecting: `OpenMemory [${build}]: Connecting (${mode})...`,
            disconnected: `OpenMemory [${build}]: Disconnected (${mode}) • Click to setup`,
            disabled: `OpenMemory [${build}]: Disabled • Click to enable`
        };

        this.statusBar.text = icons[finalStatus];
        this.statusBar.tooltip = tooltips[finalStatus];
    }
}

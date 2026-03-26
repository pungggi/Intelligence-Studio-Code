/**
 * VS Code API Shim - Provides a compatible `vscode` namespace to extensions.
 *
 * This is the core compatibility layer. Extensions call `vscode.xyz()` and
 * this shim translates those calls into IPC messages for the native frontend.
 *
 * Tier 1 APIs (manually implemented for MVP):
 * - vscode.workspace.textDocuments / onDidChangeTextDocument
 * - vscode.window.showInformationMessage / showWarningMessage / showErrorMessage
 * - vscode.languages.registerCompletionItemProvider
 * - vscode.languages.registerHoverProvider
 * - vscode.languages.createDiagnosticCollection
 * - vscode.commands.registerCommand / executeCommand
 * - vscode.window.createOutputChannel
 * - vscode.workspace.getConfiguration
 * - vscode.window.showQuickPick / showInputBox
 */

type EventCallback = (event: Buffer | Uint8Array) => void;

export class VscodeApiShim {
  private eventListeners: EventCallback[] = [];
  private registeredCommands: Map<string, (...args: unknown[]) => unknown> =
    new Map();

  /**
   * Handle a message from the native frontend (via IPC).
   */
  handleFrontendMessage(message: Buffer): void {
    // TODO M1: Deserialize FlatBuffers message
    // TODO M1: Route to appropriate API handler
    // TODO M2: Dispatch to extensions that registered for this event
  }

  /**
   * Register a callback for events that should be forwarded to the frontend.
   */
  onEvent(callback: EventCallback): void {
    this.eventListeners.push(callback);
  }

  /**
   * Emit an event to all listeners (sends to frontend via IPC).
   */
  protected emitEvent(data: Buffer | Uint8Array): void {
    for (const listener of this.eventListeners) {
      listener(data);
    }
  }

  // --- Tier 1: vscode.commands ---

  registerCommand(
    command: string,
    callback: (...args: unknown[]) => unknown
  ): void {
    this.registeredCommands.set(command, callback);
  }

  async executeCommand(
    command: string,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = this.registeredCommands.get(command);
    if (!handler) {
      throw new Error(`Command not found: ${command}`);
    }
    return handler(...args);
  }

  // --- Tier 1: vscode.window ---

  async showInformationMessage(
    message: string,
    ...items: string[]
  ): Promise<string | undefined> {
    // TODO M2: Send notification to frontend via IPC
    console.log(`[INFO] ${message}`);
    return items[0];
  }

  async showWarningMessage(
    message: string,
    ...items: string[]
  ): Promise<string | undefined> {
    console.log(`[WARN] ${message}`);
    return items[0];
  }

  async showErrorMessage(
    message: string,
    ...items: string[]
  ): Promise<string | undefined> {
    console.log(`[ERROR] ${message}`);
    return items[0];
  }

  // TODO M2: vscode.languages.createDiagnosticCollection
  // TODO M2: vscode.languages.registerCompletionItemProvider
  // TODO M2: vscode.languages.registerHoverProvider
  // TODO M2: vscode.workspace.textDocuments
  // TODO M3: vscode.window.showQuickPick
  // TODO M3: vscode.window.showInputBox
  // TODO M3: vscode.workspace.getConfiguration
  // TODO M3: vscode.window.createOutputChannel
}

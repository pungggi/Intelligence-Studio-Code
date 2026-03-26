/**
 * VS Code API Shim - Provides a compatible `vscode` namespace to extensions.
 *
 * This is the core compatibility layer. Extensions call `vscode.xyz()` and
 * this shim translates those calls into IPC messages for the native frontend.
 *
 * M2 implements:
 * - vscode.workspace.textDocuments / onDidOpenTextDocument / onDidChangeTextDocument
 * - vscode.languages.createDiagnosticCollection
 * - vscode.commands.registerCommand / executeCommand
 * - vscode.window.showInformationMessage / showWarningMessage / showErrorMessage
 */

import type { IpcMessage } from "./ipc-server";

// --- Event Emitter ---

type Listener<T> = (e: T) => void;

class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  event = (listener: Listener<T>): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }
}

// --- TextDocument ---

export interface TextDocument {
  uri: string;
  languageId: string;
  version: number;
  getText(): string;
  lineAt(line: number): { text: string };
  lineCount: number;
}

function createTextDocument(
  uri: string,
  languageId: string,
  version: number,
  text: string
): TextDocument {
  let content = text;
  return {
    uri,
    languageId,
    version,
    getText: () => content,
    get lineCount() {
      return content.split("\n").length;
    },
    lineAt(line: number) {
      const lines = content.split("\n");
      return { text: lines[line] ?? "" };
    },
  };
}

// --- Diagnostics ---

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
}

export interface DiagnosticCollection {
  name: string;
  set(uri: string, diagnostics: Diagnostic[]): void;
  delete(uri: string): void;
  clear(): void;
  dispose(): void;
}

// --- Main Shim ---

export type OutgoingCallback = (msg: IpcMessage) => void;

export class VscodeApiShim {
  private registeredCommands = new Map<
    string,
    (...args: unknown[]) => unknown
  >();
  private outgoingCallbacks: OutgoingCallback[] = [];
  private documents = new Map<string, TextDocument>();
  private diagnosticCollections: DiagnosticCollection[] = [];

  // Events
  private _onDidOpenTextDocument = new EventEmitter<TextDocument>();
  private _onDidChangeTextDocument =
    new EventEmitter<{ document: TextDocument }>();
  private _onDidCloseTextDocument = new EventEmitter<TextDocument>();

  /**
   * Handle a message from the native frontend (via IPC).
   */
  handleFrontendMessage(msg: IpcMessage): void {
    switch (msg.method) {
      case "textDocument/didOpen":
        this.handleDidOpen(msg.params as Record<string, string>);
        break;
      case "textDocument/didChange":
        this.handleDidChange(
          msg.params as { uri: string; version: number; text: string }
        );
        break;
      case "textDocument/didClose":
        this.handleDidClose(msg.params as { uri: string });
        break;
      case "executeCommand":
        this.executeCommand(
          (msg.params as Record<string, unknown>).command as string,
          ...((msg.params as Record<string, unknown>).args as unknown[] ?? [])
        );
        break;
      case "listCommands":
        this.sendOutgoing({
          method: "registeredCommands",
          params: { commands: Array.from(this.registeredCommands.keys()) },
        });
        break;
      default:
        console.log(`[ApiShim] Unknown method: ${msg.method}`);
    }
  }

  private handleDidOpen(params: Record<string, string>): void {
    const doc = createTextDocument(
      params.uri,
      params.language_id ?? "plaintext",
      parseInt(params.version ?? "1"),
      params.text ?? ""
    );
    this.documents.set(params.uri, doc);
    this._onDidOpenTextDocument.fire(doc);
    console.log(`[ApiShim] Document opened: ${params.uri}`);
  }

  private handleDidChange(params: {
    uri: string;
    version: number;
    text: string;
  }): void {
    const existing = this.documents.get(params.uri);
    if (!existing) return;

    // Create updated document
    const doc = createTextDocument(
      params.uri,
      existing.languageId,
      params.version,
      params.text
    );
    this.documents.set(params.uri, doc);
    this._onDidChangeTextDocument.fire({ document: doc });
  }

  private handleDidClose(params: { uri: string }): void {
    const doc = this.documents.get(params.uri);
    if (doc) {
      this.documents.delete(params.uri);
      this._onDidCloseTextDocument.fire(doc);
    }
  }

  onOutgoing(callback: OutgoingCallback): void {
    this.outgoingCallbacks.push(callback);
  }

  private sendOutgoing(msg: IpcMessage): void {
    for (const cb of this.outgoingCallbacks) {
      cb(msg);
    }
  }

  // --- vscode.workspace ---

  get workspace() {
    const self = this;
    return {
      get textDocuments(): TextDocument[] {
        return Array.from(self.documents.values());
      },
      onDidOpenTextDocument: self._onDidOpenTextDocument.event,
      onDidChangeTextDocument: self._onDidChangeTextDocument.event,
      onDidCloseTextDocument: self._onDidCloseTextDocument.event,
      getConfiguration(_section?: string) {
        return {
          get<T>(_key: string, defaultValue?: T): T | undefined {
            return defaultValue;
          },
          has(_key: string): boolean {
            return false;
          },
        };
      },
    };
  }

  // --- vscode.commands ---

  get commands() {
    const self = this;
    return {
      registerCommand(
        command: string,
        callback: (...args: unknown[]) => unknown
      ): { dispose: () => void } {
        self.registeredCommands.set(command, callback);
        // Notify frontend of updated command list
        self.sendOutgoing({
          method: "registeredCommands",
          params: { commands: Array.from(self.registeredCommands.keys()) },
        });
        return {
          dispose: () => {
            self.registeredCommands.delete(command);
          },
        };
      },
      async executeCommand(
        command: string,
        ...args: unknown[]
      ): Promise<unknown> {
        return self.executeCommand(command, ...args);
      },
    };
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

  // --- vscode.languages ---

  get languages() {
    const self = this;
    return {
      createDiagnosticCollection(name: string): DiagnosticCollection {
        const allDiags = new Map<string, Diagnostic[]>();

        const collection: DiagnosticCollection = {
          name,
          set(uri: string, diagnostics: Diagnostic[]) {
            allDiags.set(uri, diagnostics);
            self.publishDiagnostics(uri, name, diagnostics);
          },
          delete(uri: string) {
            allDiags.delete(uri);
            self.publishDiagnostics(uri, name, []);
          },
          clear() {
            for (const uri of allDiags.keys()) {
              self.publishDiagnostics(uri, name, []);
            }
            allDiags.clear();
          },
          dispose() {
            collection.clear();
            self.diagnosticCollections = self.diagnosticCollections.filter(
              (c) => c !== collection
            );
          },
        };

        self.diagnosticCollections.push(collection);
        return collection;
      },
    };
  }

  private publishDiagnostics(
    uri: string,
    source: string,
    diagnostics: Diagnostic[]
  ): void {
    const mapped = diagnostics.map((d) => ({
      line: d.range.start.line,
      col_start: d.range.start.character,
      col_end: d.range.end.character,
      severity: severityToString(d.severity),
      message: d.message,
      source,
    }));

    this.sendOutgoing({
      method: "publishDiagnostics",
      params: { uri, diagnostics: mapped },
    });
  }

  // --- vscode.window ---

  get window() {
    return {
      async showInformationMessage(
        message: string,
        ...items: string[]
      ): Promise<string | undefined> {
        console.log(`[INFO] ${message}`);
        return items[0];
      },
      async showWarningMessage(
        message: string,
        ...items: string[]
      ): Promise<string | undefined> {
        console.log(`[WARN] ${message}`);
        return items[0];
      },
      async showErrorMessage(
        message: string,
        ...items: string[]
      ): Promise<string | undefined> {
        console.log(`[ERROR] ${message}`);
        return items[0];
      },
    };
  }

  // --- vscode.DiagnosticSeverity ---

  get DiagnosticSeverity() {
    return DiagnosticSeverity;
  }

  /**
   * Build the full `vscode` API object to pass to extensions.
   */
  createVscodeApi() {
    return {
      workspace: this.workspace,
      commands: this.commands,
      languages: this.languages,
      window: this.window,
      DiagnosticSeverity: this.DiagnosticSeverity,
    };
  }
}

function severityToString(severity: DiagnosticSeverity): string {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return "error";
    case DiagnosticSeverity.Warning:
      return "warning";
    case DiagnosticSeverity.Information:
      return "info";
    case DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "error";
  }
}

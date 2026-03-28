/**
 * LanguageClient — VS Code compatible LSP client for the Extension Host.
 *
 * M6: Enables extensions to spawn LSP servers as child processes and
 * communicate via JSON-RPC 2.0 over stdio. The client auto-registers
 * VS Code language providers that proxy to the LSP server.
 *
 * Usage by extensions:
 *   const client = new LanguageClient("id", "Name", serverOptions, clientOptions);
 *   client.start();
 */

import { ChildProcess, spawn } from "child_process";
import type { VscodeApiShim } from "./vscode-api-shim";
import { Position, Range, Uri, Location } from "./vscode-api-shim";

// --- JSON-RPC 2.0 Types ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// --- Server Options ---

export interface ServerOptions {
  command?: string;
  args?: string[];
  options?: { cwd?: string; env?: Record<string, string> };
  run?: { command: string; args?: string[]; options?: { cwd?: string; env?: Record<string, string> } };
  debug?: { command: string; args?: string[]; options?: { cwd?: string; env?: Record<string, string> } };
  module?: string;
  transport?: number; // 0 = stdio (default)
}

export interface ClientOptions {
  documentSelector?: Array<string | { language?: string; scheme?: string; pattern?: string }>;
  synchronize?: {
    configurationSection?: string | string[];
    fileEvents?: unknown;
  };
  initializationOptions?: unknown;
  outputChannel?: unknown;
}

// --- LSP Protocol Constants ---

const LSP_CAPABILITIES = {
  textDocument: {
    completion: {
      completionItem: {
        snippetSupport: false,
        commitCharactersSupport: true,
        documentationFormat: ["plaintext", "markdown"],
        deprecatedSupport: true,
        preselectSupport: true,
        labelDetailsSupport: true,
      },
      contextSupport: true,
    },
    hover: {
      contentFormat: ["plaintext", "markdown"],
    },
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ["plaintext", "markdown"],
        parameterInformation: { labelOffsetSupport: true },
      },
      contextSupport: true,
    },
    definition: { linkSupport: false },
    references: {},
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
    formatting: {},
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"],
        },
      },
      isPreferredSupport: true,
    },
    synchronization: {
      willSave: false,
      didSave: true,
      willSaveWaitUntil: false,
    },
    publishDiagnostics: {
      relatedInformation: false,
    },
  },
  workspace: {
    workspaceFolders: false,
    configuration: true,
  },
};

// --- LanguageClient ---

export class LanguageClient {
  private id: string;
  private name: string;
  private serverOptions: ServerOptions;
  private clientOptions: ClientOptions;
  private process: ChildProcess | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private buffer = Buffer.alloc(0);
  private contentLength = -1;
  private started = false;
  private serverCapabilities: Record<string, unknown> = {};
  private disposables: Array<{ dispose(): void }> = [];
  private vscodeApi: ReturnType<VscodeApiShim["createVscodeApi"]> | null = null;
  private diagnosticCollection: { set(uri: string, diagnostics: unknown[]): void; clear(): void; dispose(): void } | null = null;

  constructor(id: string, name: string, serverOptions: ServerOptions, clientOptions: ClientOptions) {
    this.id = id;
    this.name = name;
    this.serverOptions = serverOptions;
    this.clientOptions = clientOptions;
  }

  /** Attach the VS Code API (called internally by the shim infrastructure). */
  setVscodeApi(api: ReturnType<VscodeApiShim["createVscodeApi"]>): void {
    this.vscodeApi = api;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const opts = this.serverOptions.run ?? this.serverOptions;
    const command = (opts as { command?: string }).command ?? (opts as { module?: string }).module;
    const args = (opts as { args?: string[] }).args ?? [];
    const spawnOpts = (opts as { options?: { cwd?: string; env?: Record<string, string> } }).options;

    if (!command) {
      console.error(`[LanguageClient:${this.id}] No server command specified`);
      this.started = false;
      return;
    }

    // Security: log full spawn details for audit trail
    console.warn(`[LanguageClient:${this.id}] SPAWN AUDIT: command=${JSON.stringify(command)}, args=${JSON.stringify(args)}, cwd=${JSON.stringify(spawnOpts?.cwd)}, env_overrides=${JSON.stringify(Object.keys(spawnOpts?.env ?? {}))}`);

    // Validate command doesn't contain shell metacharacters
    if (/[;&|`$]/.test(command)) {
      console.error(`[LanguageClient:${this.id}] Refusing to spawn command with shell metacharacters: ${command}`);
      this.started = false;
      return;
    }

    this.process = spawn(command, args, {
      cwd: spawnOpts?.cwd,
      env: { ...process.env, ...spawnOpts?.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data: Buffer) => this.onStdoutData(data));
    this.process.stderr?.on("data", (data: Buffer) => {
      console.error(`[LanguageClient:${this.id}] stderr: ${data.toString()}`);
    });
    this.process.on("exit", (code) => {
      console.log(`[LanguageClient:${this.id}] Server exited with code ${code}`);
      this.started = false;
    });
    this.process.on("error", (err) => {
      console.error(`[LanguageClient:${this.id}] Spawn error:`, err);
      this.started = false;
    });

    // Send LSP initialize request
    try {
      const initResult = await this.sendRequest("initialize", {
        processId: process.pid,
        capabilities: LSP_CAPABILITIES,
        rootUri: null,
        initializationOptions: this.clientOptions.initializationOptions ?? {},
      }) as { capabilities?: Record<string, unknown> };

      this.serverCapabilities = initResult?.capabilities ?? {};
      console.log(`[LanguageClient:${this.id}] Initialized, capabilities:`, Object.keys(this.serverCapabilities));

      // Send initialized notification
      this.sendNotification("initialized", {});

      // Create a single diagnostic collection for this client
      this.diagnosticCollection = this.vscodeApi!.languages.createDiagnosticCollection(this.id + "-lsp");

      // Register VS Code providers based on server capabilities
      this.registerProviders();
    } catch (err) {
      console.error(`[LanguageClient:${this.id}] Initialize failed:`, err);
    }
  }

  async stop(): Promise<void> {
    if (!this.started || !this.process) return;
    try {
      await this.sendRequest("shutdown", null);
      this.sendNotification("exit", null);
    } catch (err) {
      console.error(`[LanguageClient:${this.id}] Shutdown error:`, err);
    }
    this.process.kill();
    this.started = false;
    if (this.diagnosticCollection) {
      this.diagnosticCollection.dispose();
      this.diagnosticCollection = null;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  // --- JSON-RPC Communication ---

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error("LSP server not running"));
        return;
      }
      const id = this.nextRequestId++;
      const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`LSP request ${method} timed out`));
        }
      }, 30000);
      this.pendingRequests.set(id, { resolve, reject, timer });

      const json = JSON.stringify(msg);
      const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
      this.process.stdin.write(header + json);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin?.writable) return;
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    this.process.stdin.write(header + json);
  }

  private onStdoutData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;

        const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          console.error(`[LanguageClient:${this.id}] Invalid LSP header: ${header}`);
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        if (this.contentLength > 50 * 1024 * 1024) {
          console.error(`[LanguageClient:${this.id}] Content-Length too large (${this.contentLength}), resetting`);
          this.buffer = Buffer.alloc(0);
          this.contentLength = -1;
          return;
        }
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) break;

      const body = this.buffer.subarray(0, this.contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          this.handleResponse(msg as JsonRpcResponse);
        } else if (msg.method) {
          this.handleServerMessage(msg as JsonRpcNotification);
        }
      } catch (err) {
        console.error(`[LanguageClient:${this.id}] Parse error:`, err);
      }
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(msg.id);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private handleServerMessage(msg: JsonRpcNotification): void {
    switch (msg.method) {
      case "textDocument/publishDiagnostics": {
        // Forward diagnostics to the Extension Host via vscode API
        // (LSP server sends diagnostics, we convert to VS Code format)
        const params = msg.params as { uri: string; diagnostics: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; message: string; severity?: number; source?: string }> };
        if (this.diagnosticCollection) {
          const diags = (params.diagnostics ?? []).map(d => ({
            range: {
              start: { line: d.range.start.line, character: d.range.start.character },
              end: { line: d.range.end.line, character: d.range.end.character },
            },
            message: d.message,
            severity: this.mapSeverity(d.severity ?? 1),
            source: d.source ?? this.name,
          }));
          this.diagnosticCollection.set(params.uri, diags);
        }
        break;
      }
      case "window/logMessage":
      case "window/showMessage": {
        const p = msg.params as { type: number; message: string };
        const level = p.type <= 1 ? "error" : p.type === 2 ? "warn" : "info";
        console.log(`[LanguageClient:${this.id}] [${level}] ${p.message}`);
        break;
      }
      default:
        // Many LSP servers send custom notifications; just log them
        if (!msg.method.startsWith("$/")) {
          console.log(`[LanguageClient:${this.id}] Notification: ${msg.method}`);
        }
    }
  }

  private mapSeverity(lspSeverity: number): number {
    // LSP: 1=Error, 2=Warning, 3=Information, 4=Hint
    // VS Code DiagnosticSeverity: 0=Error, 1=Warning, 2=Information, 3=Hint
    return Math.max(0, lspSeverity - 1);
  }

  // --- Provider Registration ---

  private registerProviders(): void {
    if (!this.vscodeApi) return;
    const selector = this.clientOptions.documentSelector ?? ["*"];
    const caps = this.serverCapabilities;

    if (caps.completionProvider) {
      const triggerChars = ((caps.completionProvider as Record<string, unknown>).triggerCharacters ?? []) as string[];
      this.disposables.push(
        this.vscodeApi.languages.registerCompletionItemProvider(
          selector,
          {
            provideCompletionItems: async (doc: unknown, pos: unknown, _token: unknown, context: unknown) => {
              const d = doc as { uri: string };
              const p = pos as { line: number; character: number };
              const ctx = context as { triggerKind?: number; triggerCharacter?: string };
              const result = await this.sendRequest("textDocument/completion", {
                textDocument: { uri: d.uri },
                position: { line: p.line, character: p.character },
                context: { triggerKind: ctx?.triggerKind ?? 1, triggerCharacter: ctx?.triggerCharacter },
              });
              return result;
            },
          },
          ...triggerChars
        )
      );
    }

    if (caps.hoverProvider) {
      this.disposables.push(
        this.vscodeApi.languages.registerHoverProvider(selector, {
          provideHover: async (doc: unknown, pos: unknown) => {
            const d = doc as { uri: string };
            const p = pos as { line: number; character: number };
            return this.sendRequest("textDocument/hover", {
              textDocument: { uri: d.uri },
              position: { line: p.line, character: p.character },
            });
          },
        })
      );
    }

    if (caps.definitionProvider) {
      this.disposables.push(
        this.vscodeApi.languages.registerDefinitionProvider(selector, {
          provideDefinition: async (doc: unknown, pos: unknown) => {
            const d = doc as { uri: string };
            const p = pos as { line: number; character: number };
            return this.sendRequest("textDocument/definition", {
              textDocument: { uri: d.uri },
              position: { line: p.line, character: p.character },
            });
          },
        })
      );
    }

    if (caps.referencesProvider) {
      this.disposables.push(
        this.vscodeApi.languages.registerReferenceProvider(selector, {
          provideReferences: async (doc: unknown, pos: unknown, ctx: unknown) => {
            const d = doc as { uri: string };
            const p = pos as { line: number; character: number };
            return this.sendRequest("textDocument/references", {
              textDocument: { uri: d.uri },
              position: { line: p.line, character: p.character },
              context: ctx ?? { includeDeclaration: true },
            });
          },
        })
      );
    }

    if (caps.codeActionProvider) {
      this.disposables.push(
        this.vscodeApi.languages.registerCodeActionProvider(selector, {
          provideCodeActions: async (doc: unknown, range: unknown, ctx: unknown) => {
            const d = doc as { uri: string };
            const r = range as Range;
            const c = ctx as { diagnostics?: unknown[] };
            return this.sendRequest("textDocument/codeAction", {
              textDocument: { uri: d.uri },
              range: { start: { line: r.start.line, character: r.start.character }, end: { line: r.end.line, character: r.end.character } },
              context: { diagnostics: c?.diagnostics ?? [] },
            });
          },
        })
      );
    }

    if (caps.signatureHelpProvider) {
      const triggerChars = ((caps.signatureHelpProvider as Record<string, unknown>).triggerCharacters ?? ["(", ","]) as string[];
      this.disposables.push(
        this.vscodeApi.languages.registerSignatureHelpProvider(
          selector,
          {
            provideSignatureHelp: async (doc: unknown, pos: unknown) => {
              const d = doc as { uri: string };
              const p = pos as { line: number; character: number };
              return this.sendRequest("textDocument/signatureHelp", {
                textDocument: { uri: d.uri },
                position: { line: p.line, character: p.character },
              });
            },
          },
          ...triggerChars
        )
      );
    }

    if (caps.documentSymbolProvider) {
      this.disposables.push(
        this.vscodeApi.languages.registerDocumentSymbolProvider(selector, {
          provideDocumentSymbols: async (doc: unknown) => {
            const d = doc as { uri: string };
            return this.sendRequest("textDocument/documentSymbol", {
              textDocument: { uri: d.uri },
            });
          },
        })
      );
    }

    if (caps.documentFormattingProvider) {
      this.disposables.push(
        this.vscodeApi.languages.registerDocumentFormattingEditProvider(selector, {
          provideDocumentFormattingEdits: async (doc: unknown, options: unknown) => {
            const d = doc as { uri: string };
            const o = options as { tabSize?: number; insertSpaces?: boolean };
            return this.sendRequest("textDocument/formatting", {
              textDocument: { uri: d.uri },
              options: { tabSize: o?.tabSize ?? 2, insertSpaces: o?.insertSpaces ?? true },
            });
          },
        })
      );
    }

    console.log(`[LanguageClient:${this.id}] Registered providers for capabilities: ${Object.keys(caps).join(", ")}`);
  }

  /** Notify the LSP server that a document was opened. */
  notifyDidOpen(uri: string, languageId: string, version: number, text: string): void {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  /** Notify the LSP server that a document changed. */
  notifyDidChange(uri: string, version: number, text: string): void {
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Notify the LSP server that a document was closed. */
  notifyDidClose(uri: string): void {
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  /** Notify the LSP server that a document was saved. */
  notifyDidSave(uri: string): void {
    this.sendNotification("textDocument/didSave", {
      textDocument: { uri },
    });
  }

  get isRunning(): boolean {
    return this.started;
  }
}

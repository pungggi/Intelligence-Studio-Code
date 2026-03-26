/**
 * VS Code API Shim - Provides a compatible `vscode` namespace to extensions.
 *
 * M4 adds:
 * - vscode.window.createStatusBarItem
 * - vscode.window.createOutputChannel
 * - vscode.window.createTextEditorDecorationType
 * - vscode.Uri
 * - vscode.Range / vscode.Position
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
      try {
        listener(data);
      } catch (err) {
        console.error("[ApiShim] Event listener error:", err);
      }
    }
  }
}

// --- Position & Range ---

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  isBefore(other: Position): boolean {
    return (
      this.line < other.line ||
      (this.line === other.line && this.character < other.character)
    );
  }

  isAfter(other: Position): boolean {
    return other.isBefore(this);
  }

  translate(lineDelta: number = 0, characterDelta: number = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(
    startLine: number | Position,
    startChar?: number | Position,
    endLine?: number,
    endChar?: number
  ) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, (startChar as number) ?? 0);
      this.end = new Position(endLine ?? (startLine as number), endChar ?? (startChar as number) ?? 0);
    }
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Position) {
      return !positionOrRange.isBefore(this.start) && !positionOrRange.isAfter(this.end);
    }
    return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
  }
}

// --- Uri ---

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(scheme: string, authority: string, path: string, query: string, fragment: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  static file(path: string): Uri {
    return new Uri("file", "", path, "", "");
  }

  static parse(value: string): Uri {
    try {
      const url = new URL(value);
      return new Uri(url.protocol.replace(":", ""), url.hostname, url.pathname, url.search, url.hash);
    } catch {
      return new Uri("file", "", value, "", "");
    }
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    if (this.scheme === "file") {
      return `file://${this.path}`;
    }
    return `${this.scheme}://${this.authority}${this.path}${this.query}${this.fragment}`;
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
  const content = text;
  const lineCache = content.split("\n");
  return {
    uri,
    languageId,
    version,
    getText: () => content,
    get lineCount() {
      return lineCache.length;
    },
    lineAt(line: number) {
      return { text: lineCache[line] ?? "" };
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

// --- QuickPick / InputBox types ---

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
}

export interface QuickPickOptions {
  placeHolder?: string;
  title?: string;
  canPickMany?: boolean;
}

export interface InputBoxOptions {
  prompt?: string;
  placeHolder?: string;
  value?: string;
  title?: string;
  password?: boolean;
  validateInput?: (value: string) => string | undefined | null;
}

// --- StatusBarItem ---

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export interface StatusBarItem {
  alignment: StatusBarAlignment;
  priority: number;
  text: string;
  tooltip: string | undefined;
  color: string | undefined;
  command: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

// --- OutputChannel ---

export interface OutputChannel {
  name: string;
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

// --- TextEditorDecorationType ---

export interface DecorationRenderOptions {
  backgroundColor?: string;
  border?: string;
  borderColor?: string;
  color?: string;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
  overviewRulerColor?: string;
  after?: { contentText?: string; color?: string };
  before?: { contentText?: string; color?: string };
}

export interface TextEditorDecorationType {
  key: string;
  dispose(): void;
}

// --- Configuration ---

interface ConfigurationSection {
  get<T>(key: string, defaultValue?: T): T | undefined;
  has(key: string): boolean;
  update(key: string, value: unknown): Promise<void>;
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

  private configDefaults = new Map<string, unknown>();
  private configOverrides = new Map<string, unknown>();

  private pendingUiRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private uiRequestId = 0;
  private statusBarItemId = 0;
  private decorationTypeId = 0;

  // Events
  private _onDidOpenTextDocument = new EventEmitter<TextDocument>();
  private _onDidChangeTextDocument =
    new EventEmitter<{ document: TextDocument }>();
  private _onDidCloseTextDocument = new EventEmitter<TextDocument>();

  registerConfigurationDefaults(
    properties: Record<string, { default?: unknown }>
  ): void {
    for (const [key, schema] of Object.entries(properties)) {
      if (schema.default !== undefined) {
        this.configDefaults.set(key, schema.default);
      }
    }
  }

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
      case "quickPickResponse":
      case "inputBoxResponse": {
        const p = msg.params as Record<string, unknown>;
        const reqId = p.requestId as string;
        const pending = this.pendingUiRequests.get(reqId);
        if (pending) {
          this.pendingUiRequests.delete(reqId);
          pending.resolve(p.value ?? undefined);
        }
        break;
      }
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
    console.log(`[ApiShim] Document opened: ${params.uri} (lang: ${doc.languageId})`);
  }

  private handleDidChange(params: {
    uri: string;
    version: number;
    text: string;
  }): void {
    const existing = this.documents.get(params.uri);
    if (!existing) return;

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
      console.log(`[ApiShim] Document closed: ${params.uri}`);
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
      getConfiguration(section?: string): ConfigurationSection {
        return {
          get<T>(key: string, defaultValue?: T): T | undefined {
            const fullKey = section ? `${section}.${key}` : key;
            if (self.configOverrides.has(fullKey)) {
              return self.configOverrides.get(fullKey) as T;
            }
            if (self.configDefaults.has(fullKey)) {
              return self.configDefaults.get(fullKey) as T;
            }
            return defaultValue;
          },
          has(key: string): boolean {
            const fullKey = section ? `${section}.${key}` : key;
            return (
              self.configOverrides.has(fullKey) ||
              self.configDefaults.has(fullKey)
            );
          },
          async update(key: string, value: unknown): Promise<void> {
            const fullKey = section ? `${section}.${key}` : key;
            self.configOverrides.set(fullKey, value);
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
      source: d.source ?? source,
    }));

    this.sendOutgoing({
      method: "publishDiagnostics",
      params: { uri, diagnostics: mapped },
    });
  }

  // --- vscode.window ---

  get window() {
    const self = this;
    return {
      async showInformationMessage(
        message: string,
        ...items: string[]
      ): Promise<string | undefined> {
        console.log(`[INFO] ${message}`);
        self.sendOutgoing({
          method: "showMessage",
          params: { type: "info", message, items },
        });
        return items[0];
      },
      async showWarningMessage(
        message: string,
        ...items: string[]
      ): Promise<string | undefined> {
        console.log(`[WARN] ${message}`);
        self.sendOutgoing({
          method: "showMessage",
          params: { type: "warning", message, items },
        });
        return items[0];
      },
      async showErrorMessage(
        message: string,
        ...items: string[]
      ): Promise<string | undefined> {
        console.log(`[ERROR] ${message}`);
        self.sendOutgoing({
          method: "showMessage",
          params: { type: "error", message, items },
        });
        return items[0];
      },
      async showQuickPick(
        items: string[] | QuickPickItem[],
        options?: QuickPickOptions
      ): Promise<string | QuickPickItem | undefined> {
        const requestId = String(++self.uiRequestId);

        const normalizedItems: QuickPickItem[] = (items as unknown[]).map(
          (item) =>
            typeof item === "string" ? { label: item } : (item as QuickPickItem)
        );

        self.sendOutgoing({
          method: "showQuickPick",
          params: {
            requestId,
            items: normalizedItems,
            placeHolder: options?.placeHolder,
            title: options?.title,
          },
        });

        return new Promise((resolve, reject) => {
          self.pendingUiRequests.set(requestId, {
            resolve: resolve as (value: unknown) => void,
            reject,
          });

          setTimeout(() => {
            if (self.pendingUiRequests.has(requestId)) {
              self.pendingUiRequests.delete(requestId);
              resolve(undefined);
            }
          }, 60000);
        });
      },
      async showInputBox(
        options?: InputBoxOptions
      ): Promise<string | undefined> {
        const requestId = String(++self.uiRequestId);

        self.sendOutgoing({
          method: "showInputBox",
          params: {
            requestId,
            prompt: options?.prompt,
            placeHolder: options?.placeHolder,
            value: options?.value,
            title: options?.title,
            password: options?.password ?? false,
          },
        });

        return new Promise((resolve, reject) => {
          self.pendingUiRequests.set(requestId, {
            resolve: resolve as (value: unknown) => void,
            reject,
          });

          setTimeout(() => {
            if (self.pendingUiRequests.has(requestId)) {
              self.pendingUiRequests.delete(requestId);
              resolve(undefined);
            }
          }, 60000);
        });
      },

      createStatusBarItem(
        alignmentOrOptions?: StatusBarAlignment | { alignment?: StatusBarAlignment; id?: string },
        priority?: number
      ): StatusBarItem {
        const id = `sb-${++self.statusBarItemId}`;
        let align = StatusBarAlignment.Left;
        let prio = 0;

        if (typeof alignmentOrOptions === "number") {
          align = alignmentOrOptions;
          prio = priority ?? 0;
        } else if (alignmentOrOptions) {
          align = alignmentOrOptions.alignment ?? StatusBarAlignment.Left;
        }

        let _text = "";
        let _tooltip: string | undefined;
        let _command: string | undefined;
        let _visible = false;

        const item: StatusBarItem = {
          alignment: align,
          priority: prio,
          get text() { return _text; },
          set text(v: string) {
            _text = v;
            if (_visible) sendUpdate();
          },
          get tooltip() { return _tooltip; },
          set tooltip(v: string | undefined) {
            _tooltip = v;
            if (_visible) sendUpdate();
          },
          color: undefined,
          get command() { return _command; },
          set command(v: string | undefined) {
            _command = v;
            if (_visible) sendUpdate();
          },
          show() {
            _visible = true;
            sendUpdate();
          },
          hide() {
            _visible = false;
            self.sendOutgoing({
              method: "removeStatusBarItem",
              params: { id },
            });
          },
          dispose() {
            item.hide();
          },
        };

        function sendUpdate() {
          self.sendOutgoing({
            method: "setStatusBarItem",
            params: {
              id,
              text: _text,
              tooltip: _tooltip,
              command: _command,
              alignment: align === StatusBarAlignment.Left ? "left" : "right",
              priority: prio,
            },
          });
        }

        return item;
      },

      createOutputChannel(name: string): OutputChannel {
        const lines: string[] = [];

        return {
          name,
          append(value: string) {
            lines.push(value);
            self.sendOutgoing({
              method: "appendOutput",
              params: { channel: name, text: value },
            });
          },
          appendLine(value: string) {
            lines.push(value + "\n");
            self.sendOutgoing({
              method: "appendOutput",
              params: { channel: name, text: value + "\n" },
            });
          },
          clear() {
            lines.length = 0;
            self.sendOutgoing({
              method: "appendOutput",
              params: { channel: name, text: "\x1b[clear]" },
            });
          },
          show() {
            // Notify frontend to show output panel
            self.sendOutgoing({
              method: "showOutput",
              params: { channel: name },
            });
          },
          hide() {},
          dispose() {},
        };
      },

      createTextEditorDecorationType(
        options: DecorationRenderOptions
      ): TextEditorDecorationType {
        const key = `dec-${++self.decorationTypeId}`;
        return {
          key,
          dispose() {
            // Clear all decorations of this type
          },
        };
      },
    };
  }

  // --- vscode.DiagnosticSeverity ---

  get DiagnosticSeverity() {
    return DiagnosticSeverity;
  }

  get StatusBarAlignment() {
    return StatusBarAlignment;
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
      StatusBarAlignment: this.StatusBarAlignment,
      Uri,
      Position,
      Range,
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

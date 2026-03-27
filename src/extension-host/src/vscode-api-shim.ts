/**
 * VS Code API Shim - Provides a compatible `vscode` namespace to extensions.
 *
 * M4 adds:
 * - vscode.window.createStatusBarItem
 * - vscode.window.createOutputChannel
 * - vscode.window.createTextEditorDecorationType
 * - vscode.Uri
 * - vscode.Range / vscode.Position
 *
 * M6 adds:
 * - vscode.languages.registerCompletionItemProvider
 * - vscode.languages.registerHoverProvider
 * - vscode.languages.registerDefinitionProvider
 * - vscode.languages.registerReferenceProvider
 * - vscode.languages.registerCodeActionProvider
 * - vscode.languages.registerSignatureHelpProvider
 * - vscode.languages.registerDocumentSymbolProvider
 * - vscode.languages.registerDocumentFormattingEditProvider
 * - LSP request/response handling via lsp/request and lsp/response IPC messages
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
    for (const listener of [...this.listeners]) {
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
    } catch (e) {
      console.warn(`[Uri] Failed to parse '${value}', treating as file path:`, e);
      return new Uri("file", "", value, "", "");
    }
  }

  get fsPath(): string {
    // On Windows, URL paths like /C:/foo need the leading slash stripped
    if (/^\/[a-zA-Z]:/.test(this.path)) {
      return this.path.substring(1).replace(/\//g, "\\");
    }
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

// --- TreeView API (M5) ---

export interface TreeItem {
  label: string;
  description?: string;
  tooltip?: string;
  collapsibleState?: TreeItemCollapsibleState;
  command?: { command: string; title: string; arguments?: unknown[] };
  iconPath?: string | Uri;
  contextValue?: string;
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export interface TreeDataProvider<T> {
  getTreeItem(element: T): TreeItem | Promise<TreeItem>;
  getChildren(element?: T): T[] | Promise<T[]>;
  onDidChangeTreeData?: EventEmitter<T | undefined | null | void>['event'];
}

export interface TreeView<T> {
  readonly onDidExpandElement: EventEmitter<{ element: T }>['event'];
  readonly onDidCollapseElement: EventEmitter<{ element: T }>['event'];
  readonly onDidChangeSelection: EventEmitter<{ selection: T[] }>['event'];
  reveal(element: T): Promise<void>;
  dispose(): void;
}

// --- M6: LSP Provider Types ---

export enum CompletionItemKind {
  Text = 0, Method = 1, Function = 2, Constructor = 3, Field = 4,
  Variable = 5, Class = 6, Interface = 7, Module = 8, Property = 9,
  Unit = 10, Value = 11, Enum = 12, Keyword = 13, Snippet = 14,
  Color = 15, File = 16, Reference = 17, Folder = 18, EnumMember = 19,
  Constant = 20, Struct = 21, Event = 22, Operator = 23, TypeParameter = 24,
}

export enum CompletionTriggerKind {
  Invoke = 0,
  TriggerCharacter = 1,
  TriggerForIncompleteCompletions = 2,
}

export interface CompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  kind?: CompletionItemKind;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string | { value: string };
  range?: Range;
  additionalTextEdits?: TextEdit[];
  command?: { command: string; title: string; arguments?: unknown[] };
}

export interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

export interface CompletionContext {
  triggerKind: CompletionTriggerKind;
  triggerCharacter?: string;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface Hover {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
  range?: Range;
}

export interface Location {
  uri: Uri;
  range: Range;
}

export enum SymbolKind {
  File = 0, Module = 1, Namespace = 2, Package = 3, Class = 4,
  Method = 5, Property = 6, Field = 7, Constructor = 8, Enum = 9,
  Interface = 10, Function = 11, Variable = 12, Constant = 13,
  String = 14, Number = 15, Boolean = 16, Array = 17, Object = 18,
  Key = 19, Null = 20, EnumMember = 21, Struct = 22, Event = 23,
  Operator = 24, TypeParameter = 25,
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: SymbolKind;
  location: Location;
  containerName?: string;
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  edit?: WorkspaceEdit;
  command?: { command: string; title: string; arguments?: unknown[] };
  isPreferred?: boolean;
}

export interface WorkspaceEdit {
  entries(): [Uri, TextEdit[]][];
}

export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature: number;
  activeParameter: number;
}

export interface SignatureInformation {
  label: string;
  documentation?: string | { kind: string; value: string };
  parameters?: ParameterInformation[];
}

export interface ParameterInformation {
  label: string | [number, number];
  documentation?: string | { kind: string; value: string };
}

export interface FormattingOptions {
  tabSize: number;
  insertSpaces: boolean;
}

/** Document selector: language ID or object with language, scheme, pattern. */
export type DocumentSelector = string | { language?: string; scheme?: string; pattern?: string } |
  Array<string | { language?: string; scheme?: string; pattern?: string }>;

/** M6: Cancellation token (simplified). */
export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose(): void };
}

const nullCancellationToken: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
};

/** M6: Provider registration entry. */
interface ProviderEntry<T> {
  selector: DocumentSelector;
  provider: T;
  triggerCharacters?: string[];
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
  private treeDataProviders = new Map<string, TreeDataProvider<unknown>>();

  private pendingUiRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private uiRequestId = 0;
  private statusBarItemId = 0;
  private decorationTypeId = 0;

  // M6: LSP provider registries
  private completionProviders: ProviderEntry<{ provideCompletionItems: (...args: unknown[]) => unknown }>[] = [];
  private hoverProviders: ProviderEntry<{ provideHover: (...args: unknown[]) => unknown }>[] = [];
  private definitionProviders: ProviderEntry<{ provideDefinition: (...args: unknown[]) => unknown }>[] = [];
  private referenceProviders: ProviderEntry<{ provideReferences: (...args: unknown[]) => unknown }>[] = [];
  private codeActionProviders: ProviderEntry<{ provideCodeActions: (...args: unknown[]) => unknown }>[] = [];
  private signatureHelpProviders: ProviderEntry<{ provideSignatureHelp: (...args: unknown[]) => unknown }>[] = [];
  private documentSymbolProviders: ProviderEntry<{ provideDocumentSymbols: (...args: unknown[]) => unknown }>[] = [];
  private formattingProviders: ProviderEntry<{ provideDocumentFormattingEdits: (...args: unknown[]) => unknown }>[] = [];

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
      case "executeCommand": {
        const ecParams = msg.params as Record<string, unknown>;
        this.executeCommand(
          ecParams.command as string,
          ...((ecParams.args as unknown[]) ?? [])
        ).then((result) => {
          this.sendOutgoing({
            method: "commandResult",
            params: { command: ecParams.command, result: result ?? null },
          });
        }).catch((err) => {
          console.error(`[ExtHost] executeCommand error:`, err);
          this.sendOutgoing({
            method: "commandResult",
            params: { command: ecParams.command, error: String(err) },
          });
        });
        break;
      }
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
          if (pending.timer) clearTimeout(pending.timer);
          this.pendingUiRequests.delete(reqId);
          pending.resolve(p.value ?? undefined);
        }
        break;
      }
      // M6: LSP request handling
      case "lsp/request": {
        const p = msg.params as { request_id: string; method: string; params: Record<string, unknown> };
        this.handleLspRequest(p.request_id, p.method, p.params);
        break;
      }
      default:
        console.log(`[ApiShim] Unknown method: ${msg.method}`);
    }
  }

  // M6: Handle LSP requests from frontend, dispatch to providers, send response back
  private async handleLspRequest(requestId: string, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      const result = await this.dispatchLspRequest(method, params);
      this.sendOutgoing({
        method: "lsp/response",
        params: { request_id: requestId, result: result ?? null },
      });
    } catch (err) {
      console.error(`[ApiShim] LSP request ${method} failed:`, err);
      this.sendOutgoing({
        method: "lsp/response",
        params: { request_id: requestId, result: null, error: String(err) },
      });
    }
  }

  private async dispatchLspRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const uri = params.uri as string;
    const doc = this.documents.get(uri);
    if (!doc && method !== "textDocument/formatting") {
      return null;
    }

    switch (method) {
      case "textDocument/completion": {
        const position = new Position(params.line as number, params.character as number);
        const context: CompletionContext = {
          triggerKind: (params.triggerKind as number) ?? CompletionTriggerKind.Invoke,
          triggerCharacter: params.triggerCharacter as string | undefined,
        };
        for (const entry of this.completionProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideCompletionItems(doc, position, nullCancellationToken, context);
            if (result) return this.serializeCompletions(result);
          }
        }
        return null;
      }
      case "textDocument/hover": {
        const position = new Position(params.line as number, params.character as number);
        for (const entry of this.hoverProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideHover(doc, position, nullCancellationToken);
            if (result) return this.serializeHover(result as Hover);
          }
        }
        return null;
      }
      case "textDocument/definition": {
        const position = new Position(params.line as number, params.character as number);
        for (const entry of this.definitionProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideDefinition(doc, position, nullCancellationToken);
            if (result) return this.serializeLocations(result);
          }
        }
        return null;
      }
      case "textDocument/references": {
        const position = new Position(params.line as number, params.character as number);
        const refContext = { includeDeclaration: true };
        for (const entry of this.referenceProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideReferences(doc, position, refContext, nullCancellationToken);
            if (result) return this.serializeLocations(result);
          }
        }
        return null;
      }
      case "textDocument/codeAction": {
        const range = new Range(
          params.startLine as number, params.startCharacter as number,
          params.endLine as number, params.endCharacter as number
        );
        const codeActionContext = {
          diagnostics: (params.diagnostics ?? []) as Diagnostic[],
          only: params.only as string[] | undefined,
        };
        for (const entry of this.codeActionProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideCodeActions(doc, range, codeActionContext, nullCancellationToken);
            if (result) return this.serializeCodeActions(result as CodeAction[]);
          }
        }
        return null;
      }
      case "textDocument/signatureHelp": {
        const position = new Position(params.line as number, params.character as number);
        const sigContext = {
          triggerKind: 1,
          triggerCharacter: params.triggerCharacter as string | undefined,
          isRetrigger: false,
        };
        for (const entry of this.signatureHelpProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideSignatureHelp(doc, position, nullCancellationToken, sigContext);
            if (result) return result;
          }
        }
        return null;
      }
      case "textDocument/documentSymbol": {
        for (const entry of this.documentSymbolProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideDocumentSymbols(doc, nullCancellationToken);
            if (result) return this.serializeSymbols(result);
          }
        }
        return null;
      }
      case "textDocument/formatting": {
        const options: FormattingOptions = {
          tabSize: (params.tabSize as number) ?? 2,
          insertSpaces: (params.insertSpaces as boolean) ?? true,
        };
        for (const entry of this.formattingProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideDocumentFormattingEdits(doc, options, nullCancellationToken);
            if (result) return this.serializeTextEdits(result as TextEdit[]);
          }
        }
        return null;
      }
      default:
        console.log(`[ApiShim] Unknown LSP method: ${method}`);
        return null;
    }
  }

  // M6: Document selector matching
  private matchesSelector(selector: DocumentSelector, doc: TextDocument): boolean {
    const selectors = Array.isArray(selector) ? selector : [selector];
    for (const sel of selectors) {
      if (typeof sel === "string") {
        if (sel === doc.languageId || sel === "*") return true;
      } else {
        if (sel.language && sel.language !== doc.languageId && sel.language !== "*") continue;
        if (sel.scheme && sel.scheme !== "file") continue;
        return true;
      }
    }
    return false;
  }

  // M6: Serialization helpers for LSP results
  private serializeCompletions(result: unknown): unknown {
    if (Array.isArray(result)) {
      return { isIncomplete: false, items: result.map(i => this.serializeCompletionItem(i)) };
    }
    const list = result as CompletionList;
    if (list.items) {
      return { isIncomplete: list.isIncomplete ?? false, items: list.items.map(i => this.serializeCompletionItem(i)) };
    }
    return { isIncomplete: false, items: [] };
  }

  private serializeCompletionItem(item: unknown): unknown {
    const ci = item as CompletionItem;
    const label = typeof ci.label === "string" ? ci.label : ci.label?.label ?? "";
    const detail = typeof ci.label === "object" ? ci.label?.detail : ci.detail;
    const insertText = typeof ci.insertText === "string" ? ci.insertText :
      (ci.insertText as { value: string })?.value ?? label;
    const doc = typeof ci.documentation === "string" ? ci.documentation :
      (ci.documentation as { value: string })?.value;
    return { label, detail, documentation: doc, insertText, kind: ci.kind ?? CompletionItemKind.Text, sortText: ci.sortText, filterText: ci.filterText };
  }

  private serializeHover(hover: Hover): unknown {
    let contents: string;
    if (typeof hover.contents === "string") {
      contents = hover.contents;
    } else if (Array.isArray(hover.contents)) {
      contents = hover.contents.map(c => typeof c === "string" ? c : c.value).join("\n\n");
    } else {
      contents = (hover.contents as { value: string }).value ?? String(hover.contents);
    }
    return { contents, range: hover.range ? this.serializeRange(hover.range) : undefined };
  }

  private serializeLocations(result: unknown): unknown {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    return items.map((loc: Location) => ({
      uri: typeof loc.uri === "string" ? loc.uri : loc.uri?.toString?.() ?? String(loc.uri),
      range: loc.range ? this.serializeRange(loc.range) : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    }));
  }

  private serializeCodeActions(actions: CodeAction[]): unknown {
    return actions.map(a => ({
      title: a.title,
      kind: a.kind,
      isPreferred: a.isPreferred,
      command: a.command,
      edit: a.edit ? this.serializeWorkspaceEdit(a.edit) : undefined,
    }));
  }

  private serializeWorkspaceEdit(edit: WorkspaceEdit): unknown {
    const changes: Record<string, unknown[]> = {};
    if (typeof edit.entries === "function") {
      for (const [uri, edits] of edit.entries()) {
        const uriStr = typeof uri === "string" ? uri : uri.toString();
        changes[uriStr] = this.serializeTextEdits(edits);
      }
    }
    return { changes };
  }

  private serializeTextEdits(edits: TextEdit[]): unknown[] {
    return edits.map(e => ({
      range: this.serializeRange(e.range),
      newText: e.newText,
    }));
  }

  private serializeSymbols(result: unknown): unknown {
    if (!result) return [];
    const items = result as unknown[];
    return items.map((sym: unknown) => {
      const ds = sym as DocumentSymbol;
      if (ds.selectionRange) {
        return {
          name: ds.name, detail: ds.detail, kind: ds.kind,
          range: this.serializeRange(ds.range),
          selectionRange: this.serializeRange(ds.selectionRange),
          children: ds.children ? this.serializeSymbols(ds.children) : [],
        };
      }
      const si = sym as SymbolInformation;
      return {
        name: si.name, kind: si.kind, containerName: si.containerName,
        location: si.location ? {
          uri: si.location.uri?.toString?.() ?? String(si.location.uri),
          range: this.serializeRange(si.location.range),
        } : undefined,
      };
    });
  }

  private serializeRange(range: Range): unknown {
    return {
      start: { line: range.start.line, character: range.start.character },
      end: { line: range.end.line, character: range.end.character },
    };
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

      // M6: Provider registration APIs
      registerCompletionItemProvider(
        selector: DocumentSelector,
        provider: { provideCompletionItems: (...args: unknown[]) => unknown; resolveCompletionItem?: (...args: unknown[]) => unknown },
        ...triggerCharacters: string[]
      ): { dispose(): void } {
        const entry = { selector, provider, triggerCharacters };
        self.completionProviders.push(entry);
        console.log(`[ApiShim] CompletionItemProvider registered (triggers: ${triggerCharacters.join(", ") || "none"})`);
        return { dispose: () => { self.completionProviders = self.completionProviders.filter(e => e !== entry); } };
      },

      registerHoverProvider(
        selector: DocumentSelector,
        provider: { provideHover: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        const entry = { selector, provider };
        self.hoverProviders.push(entry);
        console.log("[ApiShim] HoverProvider registered");
        return { dispose: () => { self.hoverProviders = self.hoverProviders.filter(e => e !== entry); } };
      },

      registerDefinitionProvider(
        selector: DocumentSelector,
        provider: { provideDefinition: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        const entry = { selector, provider };
        self.definitionProviders.push(entry);
        console.log("[ApiShim] DefinitionProvider registered");
        return { dispose: () => { self.definitionProviders = self.definitionProviders.filter(e => e !== entry); } };
      },

      registerReferenceProvider(
        selector: DocumentSelector,
        provider: { provideReferences: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        const entry = { selector, provider };
        self.referenceProviders.push(entry);
        console.log("[ApiShim] ReferenceProvider registered");
        return { dispose: () => { self.referenceProviders = self.referenceProviders.filter(e => e !== entry); } };
      },

      registerCodeActionProvider(
        selector: DocumentSelector,
        provider: { provideCodeActions: (...args: unknown[]) => unknown },
        _metadata?: unknown
      ): { dispose(): void } {
        const entry = { selector, provider };
        self.codeActionProviders.push(entry);
        console.log("[ApiShim] CodeActionProvider registered");
        return { dispose: () => { self.codeActionProviders = self.codeActionProviders.filter(e => e !== entry); } };
      },

      registerSignatureHelpProvider(
        selector: DocumentSelector,
        provider: { provideSignatureHelp: (...args: unknown[]) => unknown },
        ...triggerCharactersOrMetadata: unknown[]
      ): { dispose(): void } {
        const triggerChars = triggerCharactersOrMetadata.filter(c => typeof c === "string") as string[];
        const entry = { selector, provider, triggerCharacters: triggerChars };
        self.signatureHelpProviders.push(entry);
        console.log(`[ApiShim] SignatureHelpProvider registered (triggers: ${triggerChars.join(", ") || "none"})`);
        return { dispose: () => { self.signatureHelpProviders = self.signatureHelpProviders.filter(e => e !== entry); } };
      },

      registerDocumentSymbolProvider(
        selector: DocumentSelector,
        provider: { provideDocumentSymbols: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        const entry = { selector, provider };
        self.documentSymbolProviders.push(entry);
        console.log("[ApiShim] DocumentSymbolProvider registered");
        return { dispose: () => { self.documentSymbolProviders = self.documentSymbolProviders.filter(e => e !== entry); } };
      },

      registerDocumentFormattingEditProvider(
        selector: DocumentSelector,
        provider: { provideDocumentFormattingEdits: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        const entry = { selector, provider };
        self.formattingProviders.push(entry);
        console.log("[ApiShim] DocumentFormattingEditProvider registered");
        return { dispose: () => { self.formattingProviders = self.formattingProviders.filter(e => e !== entry); } };
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
      end_line: d.range.end.line,
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
          const timer = setTimeout(() => {
            if (self.pendingUiRequests.has(requestId)) {
              self.pendingUiRequests.delete(requestId);
              resolve(undefined);
            }
          }, 60000);
          self.pendingUiRequests.set(requestId, {
            resolve: resolve as (value: unknown) => void,
            reject,
            timer,
          });
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
          const timer = setTimeout(() => {
            if (self.pendingUiRequests.has(requestId)) {
              self.pendingUiRequests.delete(requestId);
              resolve(undefined);
            }
          }, 60000);
          self.pendingUiRequests.set(requestId, {
            resolve: resolve as (value: unknown) => void,
            reject,
            timer,
          });
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

      // M5: TreeView API
      createTreeView<T>(viewId: string, options: { treeDataProvider: TreeDataProvider<T> }): TreeView<T> {
        const expandEmitter = new EventEmitter<{ element: T }>();
        const collapseEmitter = new EventEmitter<{ element: T }>();
        const selectionEmitter = new EventEmitter<{ selection: T[] }>();

        // Register the provider for later use
        self.treeDataProviders.set(viewId, options.treeDataProvider as TreeDataProvider<unknown>);

        console.log(`[ApiShim] TreeView registered: ${viewId}`);

        return {
          onDidExpandElement: expandEmitter.event,
          onDidCollapseElement: collapseEmitter.event,
          onDidChangeSelection: selectionEmitter.event,
          async reveal(_element: T) {
            // Stub — frontend will handle tree reveal
          },
          dispose() {
            self.treeDataProviders.delete(viewId);
          },
        };
      },

      registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>): { dispose(): void } {
        self.treeDataProviders.set(viewId, provider as TreeDataProvider<unknown>);
        console.log(`[ApiShim] TreeDataProvider registered: ${viewId}`);
        return {
          dispose() {
            self.treeDataProviders.delete(viewId);
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
      TreeItemCollapsibleState,
      Uri,
      Position,
      Range,
      // M6 exports
      CompletionItemKind,
      CompletionTriggerKind,
      CompletionItem: {} as unknown, // Type-only, extensions use interface
      SymbolKind,
      SignatureHelp: {} as unknown,
      CodeAction: {} as unknown,
      Location,
      TextEdit: {} as unknown,
      WorkspaceEdit: {} as unknown,
      Hover: {} as unknown,
      DocumentSymbol: {} as unknown,
      SymbolInformation: {} as unknown,
      CancellationTokenSource: class CancellationTokenSource {
        token: CancellationToken = nullCancellationToken;
        cancel() { /* noop for now */ }
        dispose() { /* noop */ }
      },
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

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
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { createGitExtension } from "./git-api";

// --- Event Emitter ---

type Listener<T> = (e: T) => void;

export class EventEmitter<T> {
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

  dispose(): void {
    this.listeners = [];
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

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(
    anchorOrLine: number | Position,
    anchorCharOrActive: number | Position,
    activeLine?: number,
    activeChar?: number
  ) {
    if (anchorOrLine instanceof Position && anchorCharOrActive instanceof Position) {
      super(anchorOrLine, anchorCharOrActive);
      this.anchor = anchorOrLine;
      this.active = anchorCharOrActive as Position;
    } else {
      const anchor = new Position(anchorOrLine as number, anchorCharOrActive as number);
      const active = new Position(activeLine!, activeChar!);
      super(anchor, active);
      this.anchor = anchor;
      this.active = active;
    }
  }

  get isReversed(): boolean {
    return this.anchor.isAfter(this.active);
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

// --- Disposable ---

export class Disposable {
  private _fn: () => void;

  constructor(callOnDispose: () => void) {
    this._fn = callOnDispose;
  }

  dispose(): void {
    this._fn();
  }

  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        try { d.dispose(); } catch { /* ignore */ }
      }
    });
  }
}

// --- MarkdownString ---

export class MarkdownString {
  value: string;
  isTrusted?: boolean;
  supportHtml?: boolean;

  constructor(value: string = "", _supportThemeIcons: boolean = false) {
    this.value = value;
  }

  appendText(value: string): MarkdownString {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language: string = ""): MarkdownString {
    this.value += `\n\`\`\`${language}\n${value}\n\`\`\`\n`;
    return this;
  }
}

// --- ThemeColor / ThemeIcon ---

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file");
  static readonly Folder = new ThemeIcon("folder");

  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor
  ) {}
}

// --- FileType ---

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
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

/** Concrete WorkspaceEdit implementation used by extensions. */
export class WorkspaceEditImpl implements WorkspaceEdit {
  private _changes = new Map<string, TextEdit[]>();

  replace(uri: Uri, range: Range, newText: string): void {
    const key = uri.toString();
    if (!this._changes.has(key)) this._changes.set(key, []);
    this._changes.get(key)!.push({ range, newText });
  }

  insert(uri: Uri, position: Position, newText: string): void {
    this.replace(uri, new Range(position, position), newText);
  }

  delete(uri: Uri, range: Range): void {
    this.replace(uri, range, '');
  }

  set(uri: Uri, edits: TextEdit[]): void {
    this._changes.set(uri.toString(), edits ? [...edits] : []);
  }

  has(uri: Uri): boolean {
    return this._changes.has(uri.toString());
  }

  get size(): number {
    return this._changes.size;
  }

  entries(): [Uri, TextEdit[]][] {
    return Array.from(this._changes.entries()).map(([uriStr, edits]) => [Uri.parse(uriStr), edits]);
  }
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

// --- M8b: WebView ---

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export interface WebviewOptions {
  enableScripts?: boolean;
  retainContextWhenHidden?: boolean;
  localResourceRoots?: unknown[];
}

export interface WebviewPanelOptions {
  enableFindWidget?: boolean;
  retainContextWhenHidden?: boolean;
}

interface WebviewPanelState {
  messageEmitter: EventEmitter<unknown>;
  disposeEmitter: EventEmitter<void>;
  disposed: boolean;
}

/** M6: Cancellation token (simplified). */
export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose(): void };
}

/** Standard PromiseLike alias used by VS Code extension API. */
export type Thenable<T> = PromiseLike<T>;

/** Fully-functional cancellation token source (matches the VS Code API spec). */
export class CancellationTokenSource {
  private _cancelled = false;
  private _listeners: Array<() => void> = [];
  readonly token: CancellationToken;

  constructor() {
    const self = this;
    this.token = {
      get isCancellationRequested() { return self._cancelled; },
      onCancellationRequested(listener: () => void): { dispose(): void } {
        if (self._cancelled) {
          try { listener(); } catch { /* ignore */ }
          return { dispose: () => {} };
        }
        self._listeners.push(listener);
        return {
          dispose() {
            const idx = self._listeners.indexOf(listener);
            if (idx >= 0) self._listeners.splice(idx, 1);
          },
        };
      },
    };
  }

  cancel(): void {
    if (!this._cancelled) {
      this._cancelled = true;
      const listeners = this._listeners.splice(0);
      for (const l of listeners) {
        try { l(); } catch { /* ignore listener errors */ }
      }
    }
  }

  dispose(): void {
    this._cancelled = true;
    this._listeners.length = 0;
  }
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

// --- Authentication types ---

export interface AuthSession {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: string[];
}

/** GitHub Device Flow — polls until user authorizes or grant expires. */
async function githubDeviceFlow(clientId: string, scopes: string[]): Promise<AuthSession> {
  const https = await import("node:https");

  function post(hostname: string, path: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let data = '';
        res.on('data', (c: unknown) => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // Step 1: Request device code
  const codeRes = JSON.parse(await post('github.com', '/login/device/code', `client_id=${clientId}&scope=${encodeURIComponent(scopes.join(' '))}`));
  const { device_code, user_code, verification_uri, expires_in, interval } = codeRes;
  if (!device_code) throw new Error('[Auth] GitHub device flow failed: ' + JSON.stringify(codeRes));

  console.log(`[Auth] GitHub: open ${verification_uri} and enter code: ${user_code}`);
  // Surface the user_code via an info notification so editor.js can show it
  process.stdout.write(JSON.stringify({ method: 'githubAuthPrompt', params: { user_code, verification_uri } }) + '\n');

  // Step 2: Poll for access token
  const deadline = Date.now() + expires_in * 1000;
  const pollInterval = (interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));
    const tokenRes = JSON.parse(await post('github.com', '/login/oauth/access_token', `client_id=${clientId}&device_code=${device_code}&grant_type=urn:ietf:params:oauth:grant-type:device_code`));
    if (tokenRes.access_token) {
      // Fetch user info
      let userId = 'github-user', userName = 'GitHub User';
      try {
        const userRes = await new Promise<string>((resolve, reject) => {
          const req = https.request({ hostname: 'api.github.com', path: '/user', headers: { 'Authorization': `Bearer ${tokenRes.access_token}`, 'User-Agent': 'CoreCode', 'Accept': 'application/vnd.github+json' } }, (res) => {
            let d = ''; res.on('data', (c: unknown) => { d += c; }); res.on('end', () => resolve(d));
          });
          req.on('error', reject); req.end();
        });
        const u = JSON.parse(userRes);
        userId = String(u.id ?? userId);
        userName = u.login ?? userName;
      } catch { /* use defaults */ }

      return { id: `github-${userId}`, accessToken: tokenRes.access_token, account: { id: userId, label: userName }, scopes };
    }
    if (tokenRes.error === 'authorization_pending') continue;
    if (tokenRes.error === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue; }
    throw new Error('[Auth] GitHub device flow error: ' + tokenRes.error);
  }
  throw new Error('[Auth] GitHub device flow timed out');
}

// --- Glob helpers ---

/** Convert a VS Code glob pattern to a RegExp (handles **, *, ?, {a,b}). */
function globToRegex(pattern: string): RegExp {
  // Normalize separators, then tokenize to avoid double-escaping
  const norm = pattern.replace(/\\/g, '/');
  let out = '';
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === '*' && norm[i + 1] === '*') {
      out += '.*';
      i += 2;
      if (norm[i] === '/') i++;
    } else if (ch === '*') {
      out += '[^/]*';
      i++;
    } else if (ch === '?') {
      out += '[^/]';
      i++;
    } else if (ch === '{') {
      const end = norm.indexOf('}', i);
      const alts = end === -1 ? [norm.slice(i + 1)] : norm.slice(i + 1, end).split(',');
      out += '(' + alts.map(a => a.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = end === -1 ? norm.length : end + 1;
    } else if ('.+^$|[]()\\'.includes(ch)) {
      out += '\\' + ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

// --- Configuration ---

interface ConfigurationSection {
  get<T>(key: string, defaultValue?: T): T | undefined;
  has(key: string): boolean;
  update(key: string, value: unknown): Promise<void>;
}

// --- vscode.tasks types ---

export enum TaskScope {
  Global = 1,
  Workspace = 2,
}

export enum TaskRevealKind {
  Always = 1,
  Silent = 2,
  Never = 3,
}

export enum TaskPanelKind {
  Shared = 1,
  Dedicated = 2,
  New = 3,
}

export class TaskGroup {
  static readonly Clean = new TaskGroup('clean', 'Clean');
  static readonly Build = new TaskGroup('build', 'Build');
  static readonly Rebuild = new TaskGroup('rebuild', 'Rebuild');
  static readonly Test = new TaskGroup('test', 'Test');

  readonly id: string;
  readonly label: string;
  isDefault?: boolean;

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }
}

export interface ShellQuotedString {
  value: string;
  quoting: number; // ShellQuoting enum value
}

export class ShellExecution {
  commandLine?: string;
  command?: string | ShellQuotedString;
  args?: (string | ShellQuotedString)[];
  options?: { cwd?: string; env?: Record<string, string> };

  constructor(
    commandOrConfig: string | ShellQuotedString,
    argsOrOptions?: (string | ShellQuotedString)[] | { cwd?: string; env?: Record<string, string> },
    options?: { cwd?: string; env?: Record<string, string> }
  ) {
    if (Array.isArray(argsOrOptions)) {
      // new ShellExecution(command, args, options?)
      this.command = commandOrConfig;
      this.args = argsOrOptions;
      this.options = options;
    } else if (typeof commandOrConfig === 'string' && !argsOrOptions) {
      // new ShellExecution(commandLine)
      this.commandLine = commandOrConfig;
    } else if (typeof commandOrConfig === 'string' && !Array.isArray(argsOrOptions)) {
      // new ShellExecution(commandLine, options)
      this.commandLine = commandOrConfig;
      this.options = argsOrOptions as { cwd?: string; env?: Record<string, string> };
    } else {
      this.command = commandOrConfig;
      this.options = options;
    }
  }
}

export class ProcessExecution {
  process: string;
  args: string[];
  options?: { cwd?: string; env?: Record<string, string> };

  constructor(
    process: string,
    argsOrOptions?: string[] | { cwd?: string; env?: Record<string, string> },
    options?: { cwd?: string; env?: Record<string, string> }
  ) {
    this.process = process;
    if (Array.isArray(argsOrOptions)) {
      this.args = argsOrOptions;
      this.options = options;
    } else {
      this.args = [];
      this.options = argsOrOptions as { cwd?: string; env?: Record<string, string> } | undefined;
    }
  }
}

export class Task {
  definition: { type: string; [key: string]: unknown };
  scope?: TaskScope | { uri?: { fsPath: string } };
  name: string;
  source?: string;
  execution?: ShellExecution | ProcessExecution;
  isBackground = false;
  problemMatchers: string[] = [];
  group?: TaskGroup;
  presentationOptions: {
    reveal?: TaskRevealKind;
    echo?: boolean;
    focus?: boolean;
    panel?: TaskPanelKind;
    showReuseMessage?: boolean;
    clear?: boolean;
  } = {};
  detail?: string;

  constructor(
    definition: { type: string; [key: string]: unknown },
    scope: TaskScope | { uri?: { fsPath: string } } | undefined,
    name: string,
    source: string,
    execution?: ShellExecution | ProcessExecution,
    problemMatchers?: string | string[]
  ) {
    this.definition = definition;
    this.scope = scope;
    this.name = name;
    this.source = source;
    this.execution = execution;
    if (problemMatchers) {
      this.problemMatchers = Array.isArray(problemMatchers) ? problemMatchers : [problemMatchers];
    }
  }
}

// --- Notebook API Types ---

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

export class NotebookCellOutputItem {
  constructor(public readonly data: Uint8Array, public readonly mime: string) {}

  static text(value: string, mime = "text/plain"): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
  }
  static stdout(value: string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(
      new TextEncoder().encode(value),
      "application/vnd.code.notebook.stdout"
    );
  }
  static stderr(value: string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(
      new TextEncoder().encode(value),
      "application/vnd.code.notebook.stderr"
    );
  }
  static error(value: Error): NotebookCellOutputItem {
    return new NotebookCellOutputItem(
      new TextEncoder().encode(JSON.stringify({ name: value.name, message: value.message, stack: value.stack })),
      "application/vnd.code.notebook.error"
    );
  }
  static json(value: unknown, mime = "application/json"): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(JSON.stringify(value)), mime);
  }
}

export class NotebookCellOutput {
  constructor(
    public items: NotebookCellOutputItem[],
    public metadata?: Record<string, unknown>
  ) {}
}

export class NotebookRange {
  constructor(public readonly start: number, public readonly end: number) {}
  get isEmpty(): boolean { return this.start === this.end; }
  with(change: { start?: number; end?: number }): NotebookRange {
    return new NotebookRange(change.start ?? this.start, change.end ?? this.end);
  }
}

export class NotebookCellData {
  outputs?: NotebookCellOutput[];
  metadata?: Record<string, unknown>;
  executionSummary?: { success?: boolean; timing?: { startTime: number; endTime: number } };
  constructor(
    public kind: NotebookCellKind,
    public value: string,
    public languageId: string
  ) {}
}

export class NotebookData {
  metadata?: Record<string, unknown>;
  constructor(public cells: NotebookCellData[]) {}
}

export class NotebookEdit {
  newCellMetadata?: Record<string, unknown>;
  newNotebookMetadata?: Record<string, unknown>;

  constructor(public range: NotebookRange, public newCells: NotebookCellData[]) {}

  static updateCellMetadata(index: number, newMetadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(index, index + 1), []);
    edit.newCellMetadata = newMetadata;
    return edit;
  }
  static updateNotebookMetadata(newMetadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(0, 0), []);
    edit.newNotebookMetadata = newMetadata;
    return edit;
  }
  static insertCells(index: number, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(new NotebookRange(index, index), newCells);
  }
  static deleteCells(range: NotebookRange): NotebookEdit {
    return new NotebookEdit(range, []);
  }
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(range, newCells);
  }
}

export enum NotebookControllerAffinity {
  Default = 1,
  Preferred = 2,
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
  // Maps viewId -> (itemId -> element) for tree view children requests
  private treeViewElements = new Map<string, Map<string, unknown>>();
  private treeViewItemCounter = 0;

  private pendingUiRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private uiRequestId = 0;
  private _applyEditRequestId = 0;
  private statusBarItemId = 0;
  private decorationTypeId = 0;
  // M8b: WebView panel state keyed by panel_id
  private webviewPanelStates = new Map<string, WebviewPanelState>();
  private webviewPanelId = 0;

  // Multi-workspace registry: workspace_id -> root_path
  private workspaceRegistry = new Map<string, string>();
  private _primaryWorkspaceRoot: string | null = null;

  // Notebook serializers registered by extensions
  private notebookSerializers = new Map<string, { deserializeNotebook: (...args: unknown[]) => unknown; serializeNotebook: (...args: unknown[]) => unknown }>();
  private _onDidOpenNotebookDocument = new EventEmitter<unknown>();
  private _onDidChangeNotebookDocument = new EventEmitter<unknown>();
  private _onDidCloseNotebookDocument = new EventEmitter<unknown>();

  // Active editor tracking
  private _activeTextEditor: TextDocument | null = null;
  private _onDidChangeActiveTextEditor = new EventEmitter<TextDocument | undefined>();

  // Save events
  private _onDidSaveTextDocument = new EventEmitter<TextDocument>();
  private _onWillSaveTextDocument = new EventEmitter<{
    document: TextDocument;
    reason: number;
    waitUntil: (thenable: Thenable<unknown>) => void;
  }>();

  // Diagnostics change event
  private _onDidChangeDiagnostics = new EventEmitter<{ uris: string[] }>();

  // Configuration change event
  private _onDidChangeConfiguration = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();

  // Terminal API
  private _terminalId = 0;
  private _onDidOpenTerminal = new EventEmitter<unknown>();
  private _onDidCloseTerminal = new EventEmitter<unknown>();
  private pendingTerminals = new Map<string, { onReady: (id: string) => void }>();

  // Decoration render options keyed by decoration type key
  private decorationRenderOptions = new Map<string, DecorationRenderOptions>();

  // Inline completion providers
  private inlineCompletionProviders: Array<{ provider: { provideInlineCompletionItems: (...args: unknown[]) => unknown } }> = [];

  // M6: LSP provider registries
  private completionProviders: ProviderEntry<{ provideCompletionItems: (...args: unknown[]) => unknown }>[] = [];
  private hoverProviders: ProviderEntry<{ provideHover: (...args: unknown[]) => unknown }>[] = [];
  private definitionProviders: ProviderEntry<{ provideDefinition: (...args: unknown[]) => unknown }>[] = [];
  private referenceProviders: ProviderEntry<{ provideReferences: (...args: unknown[]) => unknown }>[] = [];
  private codeActionProviders: ProviderEntry<{ provideCodeActions: (...args: unknown[]) => unknown }>[] = [];
  private signatureHelpProviders: ProviderEntry<{ provideSignatureHelp: (...args: unknown[]) => unknown }>[] = [];
  private documentSymbolProviders: ProviderEntry<{ provideDocumentSymbols: (...args: unknown[]) => unknown }>[] = [];
  private formattingProviders: ProviderEntry<{ provideDocumentFormattingEdits: (...args: unknown[]) => unknown }>[] = [];
  private inlayHintsProviders: ProviderEntry<{ provideInlayHints: (...args: unknown[]) => unknown }>[] = [];
  private renameProviders: ProviderEntry<{ provideRenameEdits: (...args: unknown[]) => unknown; prepareRename?: (...args: unknown[]) => unknown }>[] = [];
  private documentHighlightProviders: ProviderEntry<{ provideDocumentHighlights: (...args: unknown[]) => unknown }>[] = [];

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

  /** Register a workspace window by its root path. Updates workspaceFolders. */
  registerWorkspace(workspaceId: string, rootPath: string): void {
    this.workspaceRegistry.set(workspaceId, rootPath);
    if (!this._primaryWorkspaceRoot) {
      this._primaryWorkspaceRoot = rootPath;
    }
    this._onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
  }

  /** Unregister a workspace window when it is closed. */
  unregisterWorkspace(workspaceId: string): void {
    this.workspaceRegistry.delete(workspaceId);
    const remaining = [...this.workspaceRegistry.values()];
    this._primaryWorkspaceRoot = remaining[0] ?? null;
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
      // M8: Settings change notification
      case "settings/changed": {
        const sp = msg.params as { key: string; value: unknown };
        if (sp.key && sp.value !== undefined) {
          this.configOverrides.set(sp.key, sp.value);
          console.log(`[ApiShim] Setting updated: ${sp.key}`);
          const changedKey = sp.key;
          this._onDidChangeConfiguration.fire({
            affectsConfiguration: (section: string) => changedKey.startsWith(section),
          });
        }
        break;
      }
      // M8: Settings definitions request
      case "settings/getDefinitions": {
        const defs: Array<{ key: string; type_name: string; default_value: unknown; description: string; category?: string }> = [];
        for (const [key, value] of this.configDefaults.entries()) {
          defs.push({
            key,
            type_name: typeof value,
            default_value: value,
            description: "",
            category: key.split(".")[0] ?? "general",
          });
        }
        // Send as a request/response using the same pattern as LSP
        const reqParams = msg.params as { request_id?: string } | undefined;
        if (reqParams?.request_id) {
          this.sendOutgoing({
            method: "lsp/response",
            params: { request_id: reqParams.request_id, result: { definitions: defs } },
          });
        }
        break;
      }
      // M8: Extension installed — handled by host.ts/extension-loader directly
      case "extension/installed":
      case "extension/uninstalled":
        // These are handled at the host level, not in the API shim
        break;
      // Save events
      case "textDocument/didSave": {
        const sp = msg.params as { uri: string };
        const savedDoc = this.documents.get(sp.uri);
        if (savedDoc) {
          this._onWillSaveTextDocument.fire({
            document: savedDoc,
            reason: 1,
            waitUntil: () => {},
          });
          this._onDidSaveTextDocument.fire(savedDoc);
        }
        break;
      }
      // Terminal created response
      case "terminal/created": {
        const tp = msg.params as { request_id: string; terminal_id: string };
        const pending = this.pendingTerminals.get(tp.request_id);
        if (pending) {
          this.pendingTerminals.delete(tp.request_id);
          pending.onReady(tp.terminal_id);
        }
        break;
      }
      // M8b: Message from webview iframe to extension
      case "webview/messageFromWebview": {
        const wmp = msg.params as { panel_id: string; message: unknown };
        const wvState = this.webviewPanelStates.get(wmp.panel_id);
        if (wvState && !wvState.disposed) {
          wvState.messageEmitter.fire(wmp.message);
        }
        break;
      }
      // M8b: User closed a webview panel tab
      case "webview/closedByUser": {
        const wcp = msg.params as { panel_id: string };
        const wvState = this.webviewPanelStates.get(wcp.panel_id);
        if (wvState && !wvState.disposed) {
          wvState.disposed = true;
          this.webviewPanelStates.delete(wcp.panel_id);
          wvState.disposeEmitter.fire();
        }
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
    const doclessOk = method === "textDocument/formatting" || method.startsWith("treeView/");
    if (!doc && !doclessOk) {
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
      case "textDocument/inlineCompletion": {
        const position = new Position(params.line as number, params.character as number);
        const inlineContext = { triggerKind: (params.triggerKind as number) ?? 0, selectedCompletionInfo: undefined };
        for (const entry of this.inlineCompletionProviders) {
          const result = await entry.provider.provideInlineCompletionItems(doc, position, inlineContext, nullCancellationToken);
          if (result) {
            const items = Array.isArray(result) ? result : (result as { items: unknown[] }).items ?? [];
            const serialized = items.map((item: unknown) => {
              const it = item as { insertText: string | { value: string }; range?: Range };
              const text = typeof it.insertText === 'string' ? it.insertText : (it.insertText as { value: string })?.value ?? '';
              return { insertText: text, range: it.range ? this.serializeRange(it.range) : undefined };
            });
            if (serialized.length > 0) return { items: serialized };
          }
        }
        return { items: [] };
      }
      case "treeView/getChildren": {
        const viewId = params.view_id as string;
        const itemId = params.item_id as string | null;
        const tvProvider = this.treeDataProviders.get(viewId);
        if (!tvProvider) return [];
        const elements = this.treeViewElements.get(viewId) ?? new Map<string, unknown>();
        this.treeViewElements.set(viewId, elements);
        const parentElement = itemId ? elements.get(itemId) : undefined;
        const children = await tvProvider.getChildren(parentElement) ?? [];
        const result = [];
        for (const child of children) {
          const treeItem = await tvProvider.getTreeItem(child);
          const id = `tv-${++this.treeViewItemCounter}`;
          elements.set(id, child);
          const ti = treeItem as {
            label: string | { label: string };
            description?: string;
            tooltip?: string;
            collapsibleState?: number;
            command?: { command: string; title: string; arguments?: unknown[] };
            iconPath?: unknown;
            contextValue?: string;
          };
          const label = typeof ti.label === 'string' ? ti.label : (ti.label as { label: string })?.label ?? '';
          result.push({
            id,
            label,
            description: ti.description ?? null,
            tooltip: ti.tooltip ?? null,
            collapsible_state: ti.collapsibleState ?? 0,
            command: ti.command ? { command: ti.command.command, title: ti.command.title, args: ti.command.arguments ?? [] } : null,
            context_value: ti.contextValue ?? null,
          });
        }
        return result;
      }
      case "textDocument/inlayHint": {
        const range = new Range(
          params.startLine as number, 0,
          params.endLine as number, 0
        );
        const allHints: unknown[] = [];
        for (const entry of this.inlayHintsProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideInlayHints(doc, range, nullCancellationToken);
            if (result && Array.isArray(result)) {
              for (const hint of result) {
                const h = hint as {
                  position: Position;
                  label: string | Array<{ value: string }>;
                  kind?: number;
                  paddingLeft?: boolean;
                  paddingRight?: boolean;
                };
                const labelText = typeof h.label === 'string'
                  ? h.label
                  : h.label.map((p: { value: string }) => p.value).join('');
                allHints.push({
                  line: h.position.line,
                  character: h.position.character,
                  label: labelText,
                  kind: h.kind ?? 1,
                  paddingLeft: h.paddingLeft ?? false,
                  paddingRight: h.paddingRight ?? false,
                });
              }
            }
          }
        }
        return allHints;
      }
      case "textDocument/prepareRename": {
        const position = new Position(params.line as number, params.character as number);
        for (const entry of this.renameProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            if (entry.provider.prepareRename) {
              const result = await entry.provider.prepareRename(doc, position, nullCancellationToken);
              if (result !== undefined) return result;
            } else {
              return { placeholder: "" };
            }
          }
        }
        return null;
      }
      case "textDocument/rename": {
        const position = new Position(params.line as number, params.character as number);
        const newName = params.newName as string;
        for (const entry of this.renameProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideRenameEdits(doc, position, newName, nullCancellationToken);
            if (result) {
              const edit = result as WorkspaceEdit;
              const changes: Array<{ uri: string; edits: Array<{ start_line: number; start_col: number; end_line: number; end_col: number; new_text: string }> }> = [];
              for (const [editUri, textEdits] of edit.entries()) {
                const uriStr = typeof editUri === 'string' ? editUri : editUri.toString();
                changes.push({
                  uri: uriStr,
                  edits: (textEdits as TextEdit[]).map(te => ({
                    start_line: te.range.start.line,
                    start_col: te.range.start.character,
                    end_line: te.range.end.line,
                    end_col: te.range.end.character,
                    new_text: te.newText,
                  }))
                });
              }
              return { changes };
            }
          }
        }
        return null;
      }
      case "textDocument/documentHighlight": {
        const position = new Position(params.line as number, params.character as number);
        for (const entry of this.documentHighlightProviders) {
          if (doc && this.matchesSelector(entry.selector, doc)) {
            const result = await entry.provider.provideDocumentHighlights(doc, position, nullCancellationToken);
            if (result && Array.isArray(result)) {
              return result.map((h: unknown) => {
                const hl = h as { range: Range; kind?: number };
                return {
                  start_line: hl.range.start.line,
                  start_col: hl.range.start.character,
                  end_line: hl.range.end.line,
                  end_col: hl.range.end.character,
                  kind: hl.kind ?? 1,
                };
              });
            }
          }
        }
        return [];
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
    this._activeTextEditor = doc;
    this._onDidChangeActiveTextEditor.fire(doc);
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
      if (this._activeTextEditor?.uri === doc.uri) {
        const remaining = [...this.documents.values()];
        this._activeTextEditor = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        this._onDidChangeActiveTextEditor.fire(this._activeTextEditor ?? undefined);
      }
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
      onDidSaveTextDocument: self._onDidSaveTextDocument.event,
      onWillSaveTextDocument: self._onWillSaveTextDocument.event,
      get workspaceFolders() {
        if (self.workspaceRegistry.size > 0) {
          return [...self.workspaceRegistry.values()].map((root, index) => ({
            uri: Uri.file(root),
            name: root.split(/[\\/]/).pop() ?? "workspace",
            index,
          }));
        }
        const root = process.env.CORECODE_WORKSPACE_ROOT ?? process.cwd();
        return [{ uri: Uri.file(root), name: root.split(/[\\/]/).pop() ?? "workspace", index: 0 }];
      },
      get rootPath(): string | undefined {
        return self._primaryWorkspaceRoot ?? process.env.CORECODE_WORKSPACE_ROOT ?? process.cwd();
      },
      onDidChangeConfiguration: self._onDidChangeConfiguration.event,
      createFileSystemWatcher(_pattern: string) {
        const onCreate = new EventEmitter<Uri>();
        const onChange = new EventEmitter<Uri>();
        const onDelete = new EventEmitter<Uri>();
        return {
          onDidCreate: onCreate.event,
          onDidChange: onChange.event,
          onDidDelete: onDelete.event,
          dispose() { onCreate.dispose(); onChange.dispose(); onDelete.dispose(); },
        };
      },
      getWorkspaceFolder(uri: Uri) {
        // Find the workspace folder that contains this URI's path.
        const fsPath = uri.fsPath ?? (uri as unknown as { path: string }).path ?? "";
        for (const [, root] of self.workspaceRegistry) {
          if (fsPath.startsWith(root)) {
            return { uri: Uri.file(root), name: root.split(/[\\/]/).pop() ?? "workspace", index: 0 };
          }
        }
        const root = self._primaryWorkspaceRoot ?? process.env.CORECODE_WORKSPACE_ROOT ?? process.cwd();
        return { uri: Uri.file(root), name: root.split(/[\\/]/).pop() ?? "workspace", index: 0 };
      },
      async findFiles(include: string, exclude?: string): Promise<Uri[]> {
        const roots = self.workspaceRegistry.size > 0
          ? [...self.workspaceRegistry.values()]
          : [process.env.CORECODE_WORKSPACE_ROOT ?? process.cwd()];
        const re = globToRegex(include);
        const excludeRe = exclude ? globToRegex(exclude) : null;
        const results: Uri[] = [];
        for (const root of roots) {
          async function walk(dir: string) {
            let entries: import("node:fs").Dirent[];
            try { entries = await nodeFs.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
              if (e.name.startsWith('.')) continue;
              const full = nodePath.join(dir, e.name);
              const rel = nodePath.relative(root, full).replace(/\\/g, '/');
              if (e.isDirectory()) {
                if (!excludeRe || !excludeRe.test(rel)) await walk(full);
              } else {
                if (re.test(rel) && (!excludeRe || !excludeRe.test(rel))) {
                  results.push(Uri.file(full));
                }
              }
            }
          }
          await walk(root);
        }
        return results;
      },
      fs: {
        async stat(uri: Uri): Promise<{ type: FileType; ctime: number; mtime: number; size: number }> {
          try {
            const s = await nodeFs.stat(uri.fsPath);
            return {
              type: s.isDirectory() ? FileType.Directory : s.isSymbolicLink() ? (FileType.SymbolicLink | FileType.File) : FileType.File,
              ctime: Math.floor(s.ctimeMs),
              mtime: Math.floor(s.mtimeMs),
              size: s.size,
            };
          } catch { return { type: FileType.Unknown, ctime: 0, mtime: 0, size: 0 }; }
        },
        async readDirectory(uri: Uri): Promise<[string, FileType][]> {
          try {
            const entries = await nodeFs.readdir(uri.fsPath, { withFileTypes: true });
            return entries.map(e => [
              e.name,
              e.isDirectory() ? FileType.Directory : e.isSymbolicLink() ? (FileType.SymbolicLink | FileType.File) : FileType.File,
            ] as [string, FileType]);
          } catch { return []; }
        },
        async readFile(uri: Uri): Promise<Uint8Array> {
          try {
            const buf = await nodeFs.readFile(uri.fsPath);
            return new Uint8Array(buf);
          } catch { return new Uint8Array(0); }
        },
        async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
          await nodeFs.writeFile(uri.fsPath, content);
        },
        async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
          try {
            if (options?.recursive) {
              await nodeFs.rm(uri.fsPath, { recursive: true, force: true });
            } else {
              await nodeFs.unlink(uri.fsPath);
            }
          } catch { /* ignore */ }
        },
        async rename(source: Uri, target: Uri, _options?: { overwrite?: boolean }): Promise<void> {
          await nodeFs.rename(source.fsPath, target.fsPath);
        },
        async createDirectory(uri: Uri): Promise<void> {
          await nodeFs.mkdir(uri.fsPath, { recursive: true });
        },
        async copy(source: Uri, target: Uri, _options?: { overwrite?: boolean }): Promise<void> {
          await nodeFs.copyFile(source.fsPath, target.fsPath);
        },
      },
      async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
        const requestId = `we-${++self._applyEditRequestId}`;
        const changes: Array<{ uri: string; edits: Array<{ start_line: number; start_col: number; end_line: number; end_col: number; new_text: string }> }> = [];

        for (const [uri, textEdits] of edit.entries()) {
          const uriStr = typeof uri === 'string' ? uri : uri.toString();
          const serializedEdits = (textEdits as TextEdit[]).map(te => ({
            start_line: te.range.start.line,
            start_col: te.range.start.character,
            end_line: te.range.end.line,
            end_col: te.range.end.character,
            new_text: te.newText,
          }));
          changes.push({ uri: uriStr, edits: serializedEdits });
        }

        if (changes.length === 0) return true;

        self.sendOutgoing({
          method: "workspace/applyEdit",
          params: { request_id: requestId, changes },
        });
        return true;
      },

      registerNotebookSerializer(notebookType: string, serializer: { deserializeNotebook: (...args: unknown[]) => unknown; serializeNotebook: (...args: unknown[]) => unknown }): { dispose: () => void } {
        self.notebookSerializers.set(notebookType, serializer);
        return new Disposable(() => { self.notebookSerializers.delete(notebookType); });
      },
      onDidOpenNotebookDocument: self._onDidOpenNotebookDocument.event,
      onDidChangeNotebookDocument: self._onDidChangeNotebookDocument.event,
      onDidCloseNotebookDocument: self._onDidCloseNotebookDocument.event,
      notebookDocuments: [] as unknown[],
      async openNotebookDocument(_uriOrNotebookType: unknown, _content?: unknown): Promise<unknown> {
        return Promise.reject(new Error("[CoreCode] Notebook documents are not yet fully supported"));
      },

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

      registerDocumentRangeFormattingEditProvider(
        selector: DocumentSelector,
        provider: { provideDocumentRangeFormattingEdits: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        // Wrap as a full-document formatter so LSP dispatch can pick it up
        const wrapped = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          provideDocumentFormattingEdits: (...args: unknown[]) => {
            const [doc, , options, token] = args as [TextDocument, unknown, FormattingOptions, CancellationToken];
            return provider.provideDocumentRangeFormattingEdits(doc, new Range(new Position(0, 0), new Position(doc.lineCount, 0)), options, token);
          },
        };
        const entry = { selector, provider: wrapped };
        self.formattingProviders.push(entry);
        console.log("[ApiShim] DocumentRangeFormattingEditProvider registered");
        return { dispose: () => { self.formattingProviders = self.formattingProviders.filter(e => e !== entry); } };
      },

      registerCodeLensProvider(
        _selector: DocumentSelector,
        _provider: { provideCodeLenses: (...args: unknown[]) => unknown; resolveCodeLens?: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        console.log("[ApiShim] CodeLensProvider registered (stub — lens rendering not yet implemented)");
        return { dispose: () => {} };
      },

      registerFoldingRangeProvider(
        _selector: DocumentSelector,
        _provider: { provideFoldingRanges: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        console.log("[ApiShim] FoldingRangeProvider registered (stub)");
        return { dispose: () => {} };
      },

      registerInlineCompletionItemProvider(
        _selector: DocumentSelector,
        provider: { provideInlineCompletionItems: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        self.inlineCompletionProviders.push({ provider });
        console.log("[ApiShim] InlineCompletionItemProvider registered");
        return { dispose: () => { self.inlineCompletionProviders = self.inlineCompletionProviders.filter(p => p.provider !== provider); } };
      },

      registerInlayHintsProvider(
        selector: DocumentSelector,
        provider: { provideInlayHints: (...args: unknown[]) => unknown; resolveInlayHint?: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        self.inlayHintsProviders.push({ selector, provider });
        console.log("[ApiShim] InlayHintsProvider registered");
        return { dispose: () => { self.inlayHintsProviders = self.inlayHintsProviders.filter(p => p.provider !== provider); } };
      },

      registerRenameProvider(
        selector: DocumentSelector,
        provider: { provideRenameEdits: (...args: unknown[]) => unknown; prepareRename?: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        self.renameProviders.push({ selector, provider });
        console.log("[ApiShim] RenameProvider registered");
        return { dispose: () => { self.renameProviders = self.renameProviders.filter(p => p.provider !== provider); } };
      },

      registerDocumentHighlightProvider(
        selector: DocumentSelector,
        provider: { provideDocumentHighlights: (...args: unknown[]) => unknown }
      ): { dispose(): void } {
        self.documentHighlightProviders.push({ selector, provider });
        console.log("[ApiShim] DocumentHighlightProvider registered");
        return { dispose: () => { self.documentHighlightProviders = self.documentHighlightProviders.filter(p => p.provider !== provider); } };
      },

      match(selector: DocumentSelector, document: TextDocument): number {
        return self.matchesSelector(selector, document) ? 10 : 0;
      },

      getDiagnostics(_resource?: Uri): Diagnostic[] | [Uri, Diagnostic[]][] {
        // Stub — diagnostics are pushed outgoing; no local cache maintained
        if (_resource) return [];
        return [];
      },

      onDidChangeDiagnostics: self._onDidChangeDiagnostics.event,
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
    this._onDidChangeDiagnostics.fire({ uris: [uri] });
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
        self.decorationRenderOptions.set(key, options);
        return {
          key,
          dispose() {
            self.decorationRenderOptions.delete(key);
          },
        };
      },

      // M5: TreeView API
      createTreeView<T>(viewId: string, options: { treeDataProvider: TreeDataProvider<T> }): TreeView<T> {
        const expandEmitter = new EventEmitter<{ element: T }>();
        const collapseEmitter = new EventEmitter<{ element: T }>();
        const selectionEmitter = new EventEmitter<{ selection: T[] }>();
        const provider = options.treeDataProvider as TreeDataProvider<unknown>;

        self.treeDataProviders.set(viewId, provider);
        self.treeViewElements.set(viewId, new Map());

        // Notify frontend that this tree view is available
        self.sendOutgoing({ method: "treeView/register", params: { view_id: viewId } });

        // When data changes, notify frontend to re-fetch
        if (provider.onDidChangeTreeData) {
          provider.onDidChangeTreeData(() => {
            self.treeViewElements.set(viewId, new Map()); // clear cached elements
            self.sendOutgoing({ method: "treeView/update", params: { view_id: viewId } });
          });
        }

        console.log(`[ApiShim] TreeView registered: ${viewId}`);

        return {
          onDidExpandElement: expandEmitter.event,
          onDidCollapseElement: collapseEmitter.event,
          onDidChangeSelection: selectionEmitter.event,
          async reveal(_element: T) {
            self.sendOutgoing({ method: "treeView/reveal", params: { view_id: viewId } });
          },
          dispose() {
            self.treeDataProviders.delete(viewId);
            self.treeViewElements.delete(viewId);
            self.sendOutgoing({ method: "treeView/unregister", params: { view_id: viewId } });
          },
        };
      },

      registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>): { dispose(): void } {
        const p = provider as TreeDataProvider<unknown>;
        self.treeDataProviders.set(viewId, p);
        self.treeViewElements.set(viewId, new Map());
        self.sendOutgoing({ method: "treeView/register", params: { view_id: viewId } });
        if (p.onDidChangeTreeData) {
          p.onDidChangeTreeData(() => {
            self.treeViewElements.set(viewId, new Map());
            self.sendOutgoing({ method: "treeView/update", params: { view_id: viewId } });
          });
        }
        console.log(`[ApiShim] TreeDataProvider registered: ${viewId}`);
        return {
          dispose() {
            self.treeDataProviders.delete(viewId);
            self.treeViewElements.delete(viewId);
          },
        };
      },

      // M8b: WebView panels
      createWebviewPanel(
        viewType: string,
        title: string,
        showOptions: ViewColumn | { viewColumn: ViewColumn; preserveFocus?: boolean },
        options?: WebviewOptions & WebviewPanelOptions
      ) {
        const panelId = `webview-${++self.webviewPanelId}`;
        const column = typeof showOptions === "object" ? (showOptions as { viewColumn: ViewColumn }).viewColumn : showOptions as ViewColumn;
        const enableScripts = options?.enableScripts ?? false;

        const messageEmitter = new EventEmitter<unknown>();
        const disposeEmitter = new EventEmitter<void>();
        const panelState: WebviewPanelState = { messageEmitter, disposeEmitter, disposed: false };
        self.webviewPanelStates.set(panelId, panelState);

        self.sendOutgoing({
          method: "webview/create",
          params: { panel_id: panelId, view_type: viewType, title, column, enable_scripts: enableScripts },
        });

        let _html = "";

        const webview = {
          get html() { return _html; },
          set html(value: string) {
            _html = value;
            self.sendOutgoing({ method: "webview/setHtml", params: { panel_id: panelId, html: value } });
          },
          postMessage(message: unknown): Thenable<boolean> {
            self.sendOutgoing({ method: "webview/postMessage", params: { panel_id: panelId, message } });
            return Promise.resolve(true);
          },
          onDidReceiveMessage: messageEmitter.event,
          options: { enableScripts },
          cspSource: "https:",
        };

        const panel = {
          webview,
          viewType,
          title,
          onDidDispose: disposeEmitter.event,
          onDidChangeViewState: new EventEmitter<{ webviewPanel: unknown }>().event,
          visible: true,
          active: true,
          viewColumn: column,
          reveal(col?: ViewColumn, _preserveFocus?: boolean) {
            self.sendOutgoing({ method: "webview/reveal", params: { panel_id: panelId, column: col } });
          },
          dispose() {
            if (!panelState.disposed) {
              panelState.disposed = true;
              self.webviewPanelStates.delete(panelId);
              self.sendOutgoing({ method: "webview/close", params: { panel_id: panelId } });
              disposeEmitter.fire();
            }
          },
        };

        console.log(`[ApiShim] WebviewPanel created: ${panelId} (${viewType})`);
        return panel;
      },

      get activeTextEditor() {
        if (!self._activeTextEditor) return undefined;
        const doc = self._activeTextEditor;
        return {
          document: doc,
          selection: new Selection(new Position(0, 0), new Position(0, 0)),
          selections: [new Selection(new Position(0, 0), new Position(0, 0))],
          visibleRanges: [new Range(new Position(0, 0), new Position(0, 0))],
          viewColumn: ViewColumn.One,
          edit: async (_cb: unknown) => false,
          insertSnippet: async (_snippet: unknown) => false,
          setDecorations(type: unknown, ranges: unknown) {
            const decType = type as TextEditorDecorationType;
            if (!decType?.key) return;
            const rangeArr = (Array.isArray(ranges) ? ranges : []) as Range[];
            const opts = self.decorationRenderOptions.get(decType.key) ?? {};
            const uri = typeof doc.uri === 'string' ? doc.uri : String(doc.uri);
            self.sendOutgoing({
              method: "setDecorations",
              params: {
                uri,
                decoration_type: decType.key,
                ranges: rangeArr.map(r => ({
                  start_line: r.start?.line ?? 0,
                  start_col: r.start?.character ?? 0,
                  end_line: r.end?.line ?? 0,
                  end_col: r.end?.character ?? 0,
                  hover_message: null,
                })),
                background_color: opts.backgroundColor ?? null,
                color: opts.color ?? null,
                border: opts.border ?? null,
                border_color: opts.borderColor ?? null,
                after_text: opts.after?.contentText ?? null,
              },
            });
          },
          revealRange: (_range: unknown) => {},
        };
      },

      onDidChangeActiveTextEditor: self._onDidChangeActiveTextEditor.event,
      onDidChangeTextEditorSelection: new EventEmitter<unknown>().event,
      onDidChangeTextEditorVisibleRanges: new EventEmitter<unknown>().event,

      async withProgress<R>(
        _options: { location: unknown; title?: string; cancellable?: boolean },
        task: (
          progress: { report(value: { message?: string; increment?: number }): void },
          token: CancellationToken
        ) => Thenable<R>
      ): Promise<R> {
        return task({ report: () => {} }, nullCancellationToken);
      },

      async showTextDocument(docOrUri: unknown, options?: { selection?: Range; viewColumn?: unknown; preview?: boolean; preserveFocus?: boolean }): Promise<unknown> {
        let uriStr: string;
        if (typeof docOrUri === 'object' && docOrUri !== null) {
          const obj = docOrUri as { uri?: unknown; toString(): string };
          if (obj.uri && typeof obj.uri === 'object') {
            uriStr = (obj.uri as { toString(): string }).toString();
          } else {
            uriStr = obj.toString();
          }
        } else {
          uriStr = String(docOrUri);
        }
        self.sendOutgoing({
          method: "showTextDocument",
          params: {
            uri: uriStr,
            selection: options?.selection ? {
              start_line: options.selection.start.line,
              start_character: options.selection.start.character,
              end_line: options.selection.end.line,
              end_character: options.selection.end.character,
            } : null,
            preserve_focus: options?.preserveFocus ?? false,
          },
        });
        return self.window.activeTextEditor ?? {};
      },

      createTerminal(
        nameOrOptions?: string | { name?: string; cwd?: string; shellPath?: string; shellArgs?: string[] | string; env?: Record<string, string> },
        _shellPath?: string,
        _shellArgs?: string[] | string
      ): unknown {
        const opts = typeof nameOrOptions === "object" ? nameOrOptions : { name: nameOrOptions };
        const name = opts?.name ?? "Terminal";
        const requestId = `ext-term-${++self._terminalId}`;
        const writeQueue: string[] = [];
        let resolvedId: string | null = null;

        self.sendOutgoing({
          method: "terminal/create",
          params: { request_id: requestId, name, cwd: opts?.cwd ?? null, shell: (opts as { shellPath?: string })?.shellPath ?? null },
        });

        const terminal = {
          name,
          processId: Promise.resolve(undefined as number | undefined),
          creationOptions: opts ?? {},
          exitStatus: undefined as undefined,
          state: { isInteractedWith: false },
          sendText(text: string, addNewLine?: boolean) {
            const data = addNewLine !== false ? text + "\n" : text;
            if (resolvedId) {
              self.sendOutgoing({ method: "terminal/write", params: { terminal_id: resolvedId, data } });
            } else {
              writeQueue.push(data);
            }
          },
          show(_preserveFocus?: boolean) {
            if (resolvedId) {
              self.sendOutgoing({ method: "terminal/show", params: { terminal_id: resolvedId } });
            }
          },
          hide() {},
          dispose() {
            if (resolvedId) {
              self.sendOutgoing({ method: "terminal/close", params: { terminal_id: resolvedId } });
            }
          },
        };

        self.pendingTerminals.set(requestId, {
          onReady(terminalId: string) {
            resolvedId = terminalId;
            for (const d of writeQueue) {
              self.sendOutgoing({ method: "terminal/write", params: { terminal_id: terminalId, data: d } });
            }
            writeQueue.length = 0;
            self._onDidOpenTerminal.fire(terminal);
          },
        });

        return terminal;
      },

      onDidOpenTerminal: self._onDidOpenTerminal.event,
      onDidCloseTerminal: self._onDidCloseTerminal.event,
      onDidChangeTerminalState: new EventEmitter<unknown>().event,

      get visibleTextEditors() {
        if (!self._activeTextEditor) return [];
        const doc = self._activeTextEditor;
        return [{
          document: doc,
          selection: new Selection(new Position(0, 0), new Position(0, 0)),
          selections: [new Selection(new Position(0, 0), new Position(0, 0))],
          visibleRanges: [new Range(new Position(0, 0), new Position(0, 0))],
          viewColumn: ViewColumn.One,
          edit: async (_cb: unknown) => false,
          insertSnippet: async (_snippet: unknown) => false,
          setDecorations(type: unknown, ranges: unknown) {
            const decType = type as TextEditorDecorationType;
            if (!decType?.key) return;
            const rangeArr = (Array.isArray(ranges) ? ranges : []) as Range[];
            const opts = self.decorationRenderOptions.get(decType.key) ?? {};
            const uri = typeof doc.uri === 'string' ? doc.uri : String(doc.uri);
            self.sendOutgoing({
              method: "setDecorations",
              params: {
                uri, decoration_type: decType.key,
                ranges: rangeArr.map(r => ({ start_line: r.start?.line ?? 0, start_col: r.start?.character ?? 0, end_line: r.end?.line ?? 0, end_col: r.end?.character ?? 0, hover_message: null })),
                background_color: opts.backgroundColor ?? null, color: opts.color ?? null,
                border: opts.border ?? null, border_color: opts.borderColor ?? null,
                after_text: opts.after?.contentText ?? null,
              },
            });
          },
          revealRange: (_range: unknown) => {},
        }];
      },

      async showOpenDialog(_options?: { canSelectFiles?: boolean; canSelectFolders?: boolean; canSelectMany?: boolean; filters?: Record<string, string[]>; title?: string }): Promise<Uri[] | undefined> {
        return undefined;
      },

      async showSaveDialog(_options?: { filters?: Record<string, string[]>; title?: string; defaultUri?: Uri }): Promise<Uri | undefined> {
        return undefined;
      },

      registerWebviewViewProvider(_viewId: string, _provider: unknown, _options?: unknown): { dispose(): void } {
        return { dispose: () => {} };
      },
    };
  }

  // --- vscode.env ---

  get env() {
    return {
      appName: "CoreCode",
      appRoot: process.env.CORECODE_APP_ROOT ?? "",
      language: "en",
      uriScheme: "corecode",
      remoteName: undefined as string | undefined,
      shell: process.env.SHELL ?? process.env.COMSPEC ?? "",
      machineId: "corecode-local",
      sessionId: String(Date.now()),
      isNewAppInstall: false,
      isTelemetryEnabled: false,
      clipboard: {
        readText: async (): Promise<string> => "",
        writeText: async (_text: string): Promise<void> => {},
      },
      async openExternal(_uri: Uri): Promise<boolean> {
        console.log(`[env] openExternal: ${_uri.toString()}`);
        return false;
      },
      asExternalUri: async (uri: Uri): Promise<Uri> => uri,
    };
  }

  // --- vscode.extensions ---

  private _gitExtension: ReturnType<typeof createGitExtension> | null = null;

  get extensions() {
    const self = this;
    return {
      all: [] as unknown[],
      getExtension(extensionId: string): unknown {
        if (extensionId === 'vscode.git') {
          if (!self._gitExtension) {
            const root = process.env.CORECODE_WORKSPACE_ROOT ?? process.cwd();
            self._gitExtension = createGitExtension(root);
          }
          return self._gitExtension;
        }
        return undefined;
      },
      onDidChange: new EventEmitter<void>().event,
    };
  }

  // --- vscode.debug ---

  // --- vscode.tasks private state ---
  private _taskProviders = new Map<string, {
    provideTasks(token: CancellationToken): unknown;
    resolveTask?(task: Task, token: CancellationToken): unknown;
  }>();
  private _taskExecutions: Array<{ task: Task; terminate(): Promise<void> }> = [];
  private _onDidStartTask = new EventEmitter<{ execution: { task: Task; terminate(): Promise<void> } }>();
  private _onDidEndTask = new EventEmitter<{ execution: { task: Task; terminate(): Promise<void> } }>();
  private _onDidStartTaskProcess = new EventEmitter<{ execution: { task: Task; terminate(): Promise<void> }; processId: number }>();
  private _onDidEndTaskProcess = new EventEmitter<{ execution: { task: Task; terminate(): Promise<void> }; exitCode: number | undefined }>();

  // --- vscode.debug private state ---
  private _debugAdapterFactories = new Map<string, {
    createDebugAdapterDescriptor(session: { type: string; name: string; configuration: Record<string, unknown> }, executable: unknown): Promise<{ command: string; args: string[] } | null> | { command: string; args: string[] } | null;
  }>();
  private _debugSessionCounter = 0;
  private _onDidStartDebugSession = new EventEmitter<{ id: string; type: string; name: string }>();
  private _onDidTerminateDebugSession = new EventEmitter<{ id: string; type: string; name: string }>();

  get debug() {
    const self = this;
    return {
      startDebugging: async (folder: unknown, nameOrConfig: unknown): Promise<boolean> => {
        const config = (typeof nameOrConfig === 'object' && nameOrConfig !== null)
          ? nameOrConfig as Record<string, unknown>
          : { name: String(nameOrConfig), type: 'unknown', request: 'launch' };
        const debugType = String(config['type'] ?? 'unknown');
        const sessionId = `dap-${++self._debugSessionCounter}-${Date.now()}`;

        // Resolve debug adapter executable via registered factory, or fall back to a
        // well-known default mapping so extensions that ship their own adapter still work.
        let adapterCmd = '';
        let adapterArgs: string[] = [];

        const factory = self._debugAdapterFactories.get(debugType);
        if (factory) {
          try {
            const session = { id: sessionId, type: debugType, name: String(config['name'] ?? debugType), configuration: config as Record<string, unknown> };
            const descriptor = await factory.createDebugAdapterDescriptor(session, undefined);
            if (descriptor && 'command' in descriptor) {
              adapterCmd = descriptor.command;
              adapterArgs = descriptor.args ?? [];
            }
          } catch (err) {
            console.error(`[ApiShim] DebugAdapterDescriptorFactory.createDebugAdapterDescriptor failed: ${err}`);
          }
        }

        if (!adapterCmd) {
          // No factory or factory returned null — report to the console and bail out.
          console.warn(`[ApiShim] No debug adapter descriptor for type '${debugType}'. Ensure the extension calls registerDebugAdapterDescriptorFactory.`);
          return false;
        }

        console.log(`[ApiShim] debug.startDebugging: session=${sessionId} adapter=${adapterCmd} args=${JSON.stringify(adapterArgs)}`);

        self.sendOutgoing({
          method: "debug/startSession",
          params: {
            session_id: sessionId,
            adapter_cmd: adapterCmd,
            adapter_args: adapterArgs,
            launch_config: config,
          },
        });

        self._onDidStartDebugSession.fire({ id: sessionId, type: debugType, name: String(config['name'] ?? debugType) });
        return true;
      },

      stopDebugging: async (_session?: unknown): Promise<void> => {},

      get activeDebugSession(): unknown { return undefined; },

      activeDebugConsole: {
        append: (_value: string) => {},
        appendLine: (_value: string) => {},
      },
      breakpoints: [] as unknown[],
      onDidStartDebugSession: self._onDidStartDebugSession.event,
      onDidTerminateDebugSession: self._onDidTerminateDebugSession.event,
      onDidChangeActiveDebugSession: new EventEmitter<unknown>().event,
      onDidReceiveDebugSessionCustomEvent: new EventEmitter<unknown>().event,
      onDidChangeBreakpoints: new EventEmitter<unknown>().event,

      registerDebugConfigurationProvider: (_type: string, _provider: unknown): { dispose(): void } => {
        return { dispose: () => {} };
      },

      registerDebugAdapterDescriptorFactory: (type: string, factory: unknown): { dispose(): void } => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        self._debugAdapterFactories.set(type, factory as any);
        console.log(`[ApiShim] DebugAdapterDescriptorFactory registered for '${type}'`);
        return { dispose: () => { self._debugAdapterFactories.delete(type); } };
      },

      registerDebugAdapterTrackerFactory: (_type: string, _factory: unknown): { dispose(): void } => {
        return { dispose: () => {} };
      },

      addBreakpoints: (_breakpoints: unknown[]): void => {},
      removeBreakpoints: (_breakpoints: unknown[]): void => {},
    };
  }

  // --- vscode.tasks ---

  get tasks() {
    const self = this;
    return {
      registerTaskProvider(type: string, provider: {
        provideTasks(token: CancellationToken): unknown;
        resolveTask?(task: Task, token: CancellationToken): unknown;
      }): { dispose(): void } {
        console.log(`[ApiShim] TaskProvider registered for '${type}'`);
        self._taskProviders.set(type, provider);
        return { dispose: () => { self._taskProviders.delete(type); } };
      },

      async fetchTasks(filter?: { type?: string }): Promise<Task[]> {
        const results: Task[] = [];
        const targetType = filter?.type;
        for (const [type, provider] of self._taskProviders) {
          if (targetType && type !== targetType) continue;
          try {
            const provided = await Promise.resolve(provider.provideTasks(nullCancellationToken));
            if (Array.isArray(provided)) {
              results.push(...(provided as Task[]));
            }
          } catch (e) {
            console.error(`[ApiShim] TaskProvider '${type}' provideTasks error:`, e);
          }
        }
        return results;
      },

      async executeTask(task: Task): Promise<{ task: Task; terminate(): Promise<void> }> {
        const execution = task.execution;
        let commandLine = '';
        let cwd: string | undefined;

        if (execution instanceof ShellExecution) {
          if (execution.commandLine) {
            commandLine = execution.commandLine;
          } else if (execution.command) {
            const cmd = typeof execution.command === 'string' ? execution.command : execution.command.value;
            const argStr = (execution.args ?? [])
              .map(a => typeof a === 'string' ? a : a.value)
              .join(' ');
            commandLine = argStr ? `${cmd} ${argStr}` : cmd;
          }
          cwd = execution.options?.cwd;
        } else if (execution instanceof ProcessExecution) {
          const argStr = execution.args.join(' ');
          commandLine = argStr ? `${execution.process} ${argStr}` : execution.process;
          cwd = execution.options?.cwd;
        }

        const reveal = task.presentationOptions?.reveal ?? TaskRevealKind.Always;
        const termOpts: { name: string; cwd?: string } = { name: `Task - ${task.name}` };
        if (cwd) termOpts.cwd = cwd;
        const term = self.window.createTerminal(termOpts) as {
          sendText(text: string, addNewLine?: boolean): void;
          show(preserveFocus?: boolean): void;
          dispose(): void;
        };

        if (reveal === TaskRevealKind.Always) {
          term.show(!(task.presentationOptions?.focus ?? false));
        }

        const taskExecution = {
          task,
          terminate: async () => {
            term.dispose();
            const idx = self._taskExecutions.indexOf(taskExecution);
            if (idx >= 0) self._taskExecutions.splice(idx, 1);
            self._onDidEndTask.fire({ execution: taskExecution });
          },
        };

        self._taskExecutions.push(taskExecution);
        self._onDidStartTask.fire({ execution: taskExecution });

        if (commandLine) {
          if (task.presentationOptions?.clear) {
            term.sendText('clear', true);
          }
          term.sendText(commandLine, true);
        }

        return taskExecution;
      },

      get taskExecutions() { return self._taskExecutions as Array<{ task: Task; terminate(): Promise<void> }>; },
      onDidStartTask: self._onDidStartTask.event,
      onDidEndTask: self._onDidEndTask.event,
      onDidStartTaskProcess: self._onDidStartTaskProcess.event,
      onDidEndTaskProcess: self._onDidEndTaskProcess.event,
    };
  }

  // --- vscode.authentication ---

  private _authProviders = new Map<string, {
    id: string;
    label: string;
    provider: { getSessions(scopes: string[]): Promise<AuthSession[]>; createSession(scopes: string[]): Promise<AuthSession>; removeSession(id: string): Promise<void> };
  }>();
  private _authSessions = new Map<string, AuthSession>();
  private _onDidChangeSessions = new EventEmitter<{ provider: { id: string; label: string } }>();

  get authentication() {
    const self = this;

    // Register a built-in GitHub provider using Device Flow on first access
    if (!self._authProviders.has('github')) {
      const ghSessionKey = 'corecode.auth.github';
      const loadedSession = (() => {
        try {
          const raw = process.env[ghSessionKey];
          return raw ? (JSON.parse(raw) as AuthSession) : null;
        } catch { return null; }
      })();
      if (loadedSession) self._authSessions.set('github:' + loadedSession.scopes.join(','), loadedSession);

      self._authProviders.set('github', {
        id: 'github',
        label: 'GitHub',
        provider: {
          async getSessions(scopes: string[]): Promise<AuthSession[]> {
            const key = 'github:' + scopes.join(',');
            const cached = self._authSessions.get(key);
            return cached ? [cached] : [];
          },
          async createSession(scopes: string[]): Promise<AuthSession> {
            // GitHub Device Flow — requires CORECODE_GITHUB_CLIENT_ID env var
            const clientId = process.env.CORECODE_GITHUB_CLIENT_ID ?? '';
            if (!clientId) throw new Error('[Auth] Set CORECODE_GITHUB_CLIENT_ID env var to enable GitHub auth');
            const session = await githubDeviceFlow(clientId, scopes);
            const key = 'github:' + scopes.join(',');
            self._authSessions.set(key, session);
            self._onDidChangeSessions.fire({ provider: { id: 'github', label: 'GitHub' } });
            return session;
          },
          async removeSession(id: string): Promise<void> {
            for (const [k, v] of self._authSessions.entries()) {
              if (v.id === id) { self._authSessions.delete(k); break; }
            }
            self._onDidChangeSessions.fire({ provider: { id: 'github', label: 'GitHub' } });
          },
        },
      });
    }

    return {
      getSession: async (providerId: string, scopes: string[], options?: { createIfNone?: boolean; silent?: boolean }): Promise<AuthSession | undefined> => {
        const prov = self._authProviders.get(providerId);
        if (!prov) {
          console.warn(`[Auth] No provider registered for '${providerId}'`);
          return undefined;
        }
        const existing = await prov.provider.getSessions(scopes);
        if (existing.length > 0) return existing[0];
        if (options?.silent) return undefined;
        if (options?.createIfNone) {
          try { return await prov.provider.createSession(scopes); }
          catch (e) { console.error(`[Auth] Failed to create session for ${providerId}:`, e); return undefined; }
        }
        return undefined;
      },
      onDidChangeSessions: self._onDidChangeSessions.event,
      registerAuthenticationProvider: (id: string, label: string, provider: unknown, _options?: unknown): { dispose(): void } => {
        const p = provider as { getSessions(scopes: string[]): Promise<AuthSession[]>; createSession(scopes: string[]): Promise<AuthSession>; removeSession(id: string): Promise<void> };
        self._authProviders.set(id, { id, label, provider: p });
        console.log(`[Auth] Provider registered: ${id} (${label})`);
        return { dispose: () => { self._authProviders.delete(id); } };
      },
    };
  }

  // --- vscode.comments ---

  get comments() {
    const self = this;
    return {
      createCommentController: (controllerId: string, controllerLabel: string) => {
        const threads = new Map<string, unknown>();
        let threadCounter = 0;

        function deleteThread(id: string) {
          threads.delete(id);
          self.sendOutgoing({ method: "comments/threadDelete", params: { id } });
        }

        const controller = {
          id: controllerId,
          label: controllerLabel,
          commentingRangeProvider: undefined as unknown,
          createCommentThread: (uri: Uri, range: Range, initialComments: unknown[]) => {
            const id = `${controllerId}:${++threadCounter}`;

            function pushUpdate(target: Record<string, unknown>) {
              const rawComments = target.comments as Array<{
                author?: { name?: string; iconPath?: { external?: string } };
                body?: { value?: string } | string;
                mode?: number;
                timestamp?: Date;
              }>;
              const comments = (rawComments ?? []).map(c => ({
                author: {
                  name: c.author?.name ?? "Unknown",
                  icon_url: c.author?.iconPath?.external ?? undefined,
                },
                body: typeof c.body === "string" ? c.body : (c.body?.value ?? ""),
                mode: c.mode ?? 1,
                timestamp: c.timestamp?.toISOString() ?? undefined,
              }));
              self.sendOutgoing({
                method: "comments/threadUpdate",
                params: {
                  id,
                  controller_id: controllerId,
                  uri: uri.toString(),
                  start_line: range.start.line,
                  end_line: range.end.line,
                  comments,
                  collapsible_state: (target.collapsibleState as number) ?? 0,
                  label: (target.label as string | undefined) ?? undefined,
                  context_value: (target.contextValue as string | undefined) ?? undefined,
                },
              });
            }

            const threadData: Record<string, unknown> = {
              id,
              uri,
              range,
              comments: initialComments,
              collapsibleState: 0,
              label: undefined,
              contextValue: undefined,
              dispose: () => { deleteThread(id); },
            };

            const proxy = new Proxy(threadData, {
              set(target, prop, value) {
                target[prop as string] = value;
                if (prop === "comments" || prop === "collapsibleState" || prop === "label") {
                  pushUpdate(target);
                }
                return true;
              },
            });

            threads.set(id, proxy);
            pushUpdate(threadData);
            return proxy;
          },
          dispose: () => {
            for (const id of threads.keys()) {
              self.sendOutgoing({ method: "comments/threadDelete", params: { id } });
            }
            threads.clear();
          },
        };
        return controller;
      },
    };
  }

  // --- vscode.scm ---

  get scm() {
    const self = this;
    return {
      createSourceControl: (id: string, label: string, rootUri?: Uri) => {
        const groups = new Map<string, { id: string; label: string; resourceStates: unknown[] }>();

        function pushUpdate() {
          const resource_groups = Array.from(groups.values()).map(g => ({
            id: g.id,
            label: g.label,
            resources: (g.resourceStates as Array<{ resourceUri?: Uri; uri?: Uri; decorations?: { tooltip?: string; letter?: string; color?: { id?: string } } }>).map(r => {
              const uri = (r.resourceUri ?? r.uri)?.toString() ?? "";
              const dec = r.decorations ?? {};
              return {
                uri,
                decoration_tooltip: dec.tooltip ?? undefined,
                decoration_letter: dec.letter ?? undefined,
                decoration_color: dec.color?.id ?? undefined,
              };
            }),
          }));
          self.sendOutgoing({
            method: "scm/update",
            params: {
              id,
              label,
              root_uri: rootUri?.toString() ?? undefined,
              resource_groups,
              count: resource_groups.reduce((s, g) => s + g.resources.length, 0),
            },
          });
        }

        const sc = {
          id,
          label,
          rootUri,
          inputBox: { value: "", placeholder: "" },
          count: 0,
          statusBarCommands: undefined as unknown,
          acceptInputCommand: undefined as unknown,
          createResourceGroup: (gId: string, gLabel: string) => {
            const group = { id: gId, label: gLabel, resourceStates: [] as unknown[], dispose: () => { groups.delete(gId); pushUpdate(); } };
            // Proxy resourceStates so any assignment triggers pushUpdate
            const proxy = new Proxy(group, {
              set(target, prop, value) {
                (target as Record<string | symbol, unknown>)[prop as string] = value;
                if (prop === "resourceStates") pushUpdate();
                return true;
              },
            });
            groups.set(gId, proxy);
            pushUpdate();
            return proxy;
          },
          dispose: () => {
            self.sendOutgoing({ method: "scm/remove", params: { id } });
          },
        };
        return sc;
      },
      inputBox: { value: "" },
    };
  }

  // --- vscode.DiagnosticSeverity ---

  // --- vscode.notebooks ---

  get notebooks() {
    const self = this;
    return {
      /** Create a notebook controller (kernel). Returns a functional stub. */
      createNotebookController(
        id: string,
        notebookType: string,
        label: string,
        _handler?: (cells: unknown[], notebook: unknown, controller: unknown) => void | Thenable<void>
      ) {
        const _onDidChangeSelectedNotebooks = new EventEmitter<unknown>();
        const controller = {
          id,
          notebookType,
          label,
          supportedLanguages: undefined as unknown,
          supportsExecutionOrder: false,
          description: undefined as unknown,
          detail: undefined as unknown,
          interruptHandler: undefined as unknown,
          onDidChangeSelectedNotebooks: _onDidChangeSelectedNotebooks.event,
          /** Create an execution context for a cell. Returns a no-op stub. */
          createNotebookCellExecution(cell: unknown) {
            return {
              cell,
              executionOrder: undefined as number | undefined,
              token: nullCancellationToken,
              start(_startTime?: number) {},
              end(_success?: boolean | undefined, _endTime?: number) {},
              clearOutput(_cell?: unknown): Thenable<void> { return Promise.resolve(); },
              replaceOutput(_out: unknown, _cell?: unknown): Thenable<void> { return Promise.resolve(); },
              appendOutput(_out: unknown, _cell?: unknown): Thenable<void> { return Promise.resolve(); },
              replaceOutputItems(_items: unknown, _output: unknown): Thenable<void> { return Promise.resolve(); },
              appendOutputItems(_items: unknown, _output: unknown): Thenable<void> { return Promise.resolve(); },
            };
          },
          updateNotebookAffinity(_notebook: unknown, _affinity: NotebookControllerAffinity) {},
          dispose() { _onDidChangeSelectedNotebooks.dispose(); },
        };
        // Fire didChange so extensions know the controller is available
        self._onDidChangeConfiguration.fire({ affectsConfiguration: () => false });
        return controller;
      },

      onDidOpenNotebookDocument: self._onDidOpenNotebookDocument.event,
      onDidChangeNotebookDocument: self._onDidChangeNotebookDocument.event,
      onDidCloseNotebookDocument: self._onDidCloseNotebookDocument.event,
      onDidSaveNotebookDocument: new EventEmitter<unknown>().event,
      /** All currently open notebook documents (empty until UI support is added). */
      notebookDocuments: [] as unknown[],
      openNotebookDocument(_uriOrNotebookType: unknown, _content?: unknown): Thenable<unknown> {
        return Promise.reject(new Error("[CoreCode] Opening notebook documents is not yet supported"));
      },
    };
  }

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
      env: this.env,
      extensions: this.extensions,
      debug: this.debug,
      tasks: this.tasks,
      authentication: this.authentication,
      comments: this.comments,
      notebooks: this.notebooks,
      scm: this.scm,
      DiagnosticSeverity: this.DiagnosticSeverity,
      StatusBarAlignment: this.StatusBarAlignment,
      TreeItemCollapsibleState,
      Uri,
      Position,
      Range,
      Selection,
      // New utility classes
      EventEmitter,
      Disposable,
      MarkdownString,
      ThemeColor,
      ThemeIcon,
      FileType,
      // M6 exports
      CompletionItemKind,
      CompletionTriggerKind,
      CompletionItem: {} as unknown, // Type-only, extensions use interface
      SymbolKind,
      SignatureHelp: {} as unknown,
      CodeAction: {} as unknown,
      Location,
      TextEdit: {} as unknown,
      WorkspaceEdit: WorkspaceEditImpl,
      Hover: {} as unknown,
      DocumentSymbol: {} as unknown,
      SymbolInformation: {} as unknown,
      CancellationTokenSource,
      ViewColumn,
      // Task classes/enums
      TaskScope,
      TaskRevealKind,
      TaskPanelKind,
      TaskGroup,
      Task,
      ShellExecution,
      ProcessExecution,
      ShellQuoting: { Escape: 1, Strong: 2, Weak: 3 },
      // DAP classes (top-level vscode exports)
      DebugAdapterExecutable: class DebugAdapterExecutable {
        command: string;
        args: string[];
        constructor(command: string, args: string[] = []) {
          this.command = command;
          this.args = args;
        }
      },
      DebugAdapterServer: class DebugAdapterServer {
        port: number;
        host?: string;
        constructor(port: number, host?: string) {
          this.port = port;
          this.host = host;
        }
      },
      // Notebook API exports
      NotebookCellKind,
      NotebookCellOutputItem,
      NotebookCellOutput,
      NotebookRange,
      NotebookCellData,
      NotebookData,
      NotebookEdit,
      NotebookControllerAffinity,
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

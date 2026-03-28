# CoreCode Native Extension System — WIT API Specification

> **Status**: Planning
> **Created**: 2026-03-28

---

## Design principles

1. **Data in, data out.** Every exported function accepts plain data and returns plain data.
   No object handles, no event subscriptions, no disposables inside WASM.
   All state lives in the host; extensions are stateless responders.

2. **Host calls extension; extension never calls back asynchronously.**
   Extensions export functions the host invokes. The host provides import functions for
   reading workspace state. There are no callbacks or listeners inside WASM.

3. **Portability over completeness.** Every interface in this spec maps to an equivalent
   concept in both Zed's extension API and VS Code's extension API, enabling the cross-editor
   build tool to produce working packages for both targets.

---

## Full WIT definition

```wit
// wit/corecode.wit
package corecode:extension@0.1.0;

// ── Shared types ───────────────────────────────────────────────────────────

interface types {
  record position {
    line: u32,
    character: u32,
  }

  record range {
    start: position,
    end: position,
  }

  record location {
    uri: string,
    range: range,
  }

  record diagnostic {
    range: range,
    severity: severity,
    message: string,
    source: option<string>,
    code: option<string>,
  }

  enum severity {
    error,
    warning,
    information,
    hint,
  }

  record completion-item {
    label: string,
    kind: option<completion-kind>,
    detail: option<string>,
    documentation: option<string>,
    insert-text: string,
    filter-text: option<string>,
  }

  enum completion-kind {
    text, method, function, constructor, field, variable,
    class, interface, module, property, unit, value, enum-member,
    keyword, snippet, color, file, reference, folder,
  }

  record hover-result {
    contents: string,        // Markdown
    range: option<range>,
  }

  record text-edit {
    range: range,
    new-text: string,
  }

  record code-action {
    title: string,
    kind: option<string>,    // e.g. "quickfix", "refactor"
    edits: list<text-edit>,
  }

  record symbol {
    name: string,
    kind: symbol-kind,
    location: location,
    container-name: option<string>,
  }

  enum symbol-kind {
    file, module, namespace, package, class, method, property,
    field, constructor, enum, interface, function, variable,
    constant, string, number, boolean, array, object, key, null,
    enum-member, struct, event, operator, type-parameter,
  }

  record folding-range {
    start-line: u32,
    end-line: u32,
    kind: option<string>,   // "comment", "imports", "region"
  }
}

// ── Host imports — workspace access ────────────────────────────────────────
// The host implements these; extensions call them to read workspace state.

interface workspace {
  use types.{range};

  // Read the current content of a file (workspace-relative path only).
  // Returns err if the path is outside the workspace or capability denied.
  read-file: func(path: string) -> result<string, string>;

  // Return all workspace-relative file paths matching a glob.
  find-files: func(glob: string) -> result<list<string>, string>;

  // Return the workspace root URI.
  root-uri: func() -> string;

  // Read a configuration value by dotted key (e.g. "editor.tabSize").
  get-config: func(key: string) -> option<string>;
}

// ── Host imports — UI ───────────────────────────────────────────────────────

interface ui {
  // Append a line to a named output channel.
  log: func(channel: string, message: string);

  // Show a transient notification. level: "info" | "warning" | "error"
  show-message: func(level: string, message: string);

  // Create or update a status bar item. Passing empty text removes it.
  set-status: func(id: string, text: string, tooltip: option<string>);
}

// ── Host imports — HTTP (capability-gated) ──────────────────────────────────

interface http {
  record http-request {
    method: string,
    url: string,
    headers: list<tuple<string, string>>,
    body: option<list<u8>>,
  }

  record http-response {
    status: u16,
    headers: list<tuple<string, string>>,
    body: list<u8>,
  }

  // Requires `network_fetch = true` in corecode.toml.
  fetch: func(request: http-request) -> result<http-response, string>;
}

// ── Host imports — Webview ──────────────────────────────────────────────────

interface webview-host {
  // Open a new webview panel. Returns an opaque panel-id.
  // The host renders the HTML returned by the extension's webview-provider.
  open-panel: func(panel-id: string, title: string, column: u8) -> result<_, string>;

  // Send a JSON message from the host to the webview JS.
  post-to-webview: func(panel-id: string, json: string) -> result<_, string>;

  // Close a panel programmatically.
  close-panel: func(panel-id: string);
}

// ── Extension exports — lifecycle ───────────────────────────────────────────

interface lifecycle {
  // Called once when the extension is loaded. Return err to abort activation.
  activate: func() -> result<_, string>;

  // Called when the host is shutting down. Best-effort; return value ignored.
  deactivate: func();
}

// ── Extension exports — language provider ───────────────────────────────────

interface language-provider {
  use types.{
    position, range, completion-item, hover-result,
    diagnostic, text-edit, code-action, location,
    symbol, folding-range,
  };

  // Return completions at the given position.
  completions: func(uri: string, pos: position, trigger: option<string>)
    -> result<list<completion-item>, string>;

  // Return hover documentation.
  hover: func(uri: string, pos: position)
    -> result<option<hover-result>, string>;

  // Return diagnostics for the current file content.
  diagnostics: func(uri: string, content: string)
    -> result<list<diagnostic>, string>;

  // Format entire document.
  format-document: func(uri: string, content: string)
    -> result<list<text-edit>, string>;

  // Format a selected range.
  format-range: func(uri: string, content: string, range: range)
    -> result<list<text-edit>, string>;

  // Go to definition.
  definition: func(uri: string, pos: position)
    -> result<option<location>, string>;

  // Find all references.
  references: func(uri: string, pos: position, include-decl: bool)
    -> result<list<location>, string>;

  // Rename symbol.
  rename: func(uri: string, pos: position, new-name: string)
    -> result<list<text-edit>, string>;

  // Code actions for a range (quickfixes, refactors).
  code-actions: func(uri: string, range: range, diagnostics: list<diagnostic>)
    -> result<list<code-action>, string>;

  // Workspace symbols (fuzzy search by query string).
  workspace-symbols: func(query: string)
    -> result<list<symbol>, string>;

  // Folding ranges for the document.
  folding-ranges: func(uri: string, content: string)
    -> result<list<folding-range>, string>;
}

// ── Extension exports — grammar provider ────────────────────────────────────

interface grammar-provider {
  // Return the tree-sitter grammar .wasm bytes for this language.
  grammar-wasm: func() -> list<u8>;

  // Return the tree-sitter highlights.scm query string.
  highlights-query: func() -> string;

  // Return the injections.scm query string (optional).
  injections-query: func() -> option<string>;

  // Return bracket pair definitions as JSON array of [open, close] pairs.
  bracket-pairs: func() -> string;
}

// ── Extension exports — webview provider ────────────────────────────────────

interface webview-provider {
  // Return the HTML to render when a panel is opened.
  // panel-id is the same opaque id passed to webview-host.open-panel.
  get-html: func(panel-id: string, state: option<string>) -> string;

  // Called when the webview JS posts a message. Return an optional
  // JSON response that will be sent back to the webview via postMessage.
  on-message: func(panel-id: string, json: string) -> option<string>;

  // Called when the user closes the panel.
  on-close: func(panel-id: string);
}

// ── World definition ────────────────────────────────────────────────────────

world corecode-extension {
  // Imports: what the extension can call
  import workspace;
  import ui;
  import http;
  import webview-host;

  // Exports: what the host calls on the extension
  export lifecycle;
  export language-provider;   // optional — only link if extension exports it
  export grammar-provider;    // optional
  export webview-provider;    // optional — only if webview_panels = true
}
```

---

## Optional exports

Not every extension implements every interface. The WASM host detects at load time which
exports are present by inspecting the module's export table:

| Exported function | Interface required |
|:------------------|:------------------|
| `corecode:extension/lifecycle#activate` | always required |
| `corecode:extension/language-provider#completions` | opt-in |
| `corecode:extension/grammar-provider#grammar-wasm` | opt-in |
| `corecode:extension/webview-provider#get-html` | opt-in |

If `webview-provider` is exported but `webview_panels = true` is absent from `corecode.toml`,
the host refuses to activate the extension and reports a capability mismatch error.

---

## Mapping to VS Code API (cross-editor reference)

| WIT interface / function | VS Code equivalent |
|:-------------------------|:------------------|
| `language-provider#completions` | `registerCompletionItemProvider` |
| `language-provider#hover` | `registerHoverProvider` |
| `language-provider#diagnostics` | `createDiagnosticCollection` + `onDidChangeTextDocument` |
| `language-provider#format-document` | `registerDocumentFormattingEditProvider` |
| `language-provider#definition` | `registerDefinitionProvider` |
| `language-provider#references` | `registerReferenceProvider` |
| `language-provider#rename` | `registerRenameProvider` |
| `language-provider#code-actions` | `registerCodeActionsProvider` |
| `language-provider#workspace-symbols` | `registerWorkspaceSymbolProvider` |
| `language-provider#folding-ranges` | `registerFoldingRangeProvider` |
| `grammar-provider` | tree-sitter grammar contribution (no direct VS Code equivalent) |
| `webview-provider` | `WebviewPanel` + `onDidReceiveMessage` |
| `workspace#read-file` | `workspace.fs.readFile` |
| `workspace#find-files` | `workspace.findFiles` |
| `workspace#get-config` | `workspace.getConfiguration` |
| `ui#log` | `window.createOutputChannel` |
| `ui#show-message` | `window.showInformationMessage` |
| `ui#set-status` | `window.createStatusBarItem` |
| `http#fetch` | `fetch` (available in Node.js extension context) |

## Mapping to Zed extension API

| WIT interface / function | Zed equivalent |
|:-------------------------|:-------------|
| `language-provider#completions` | `language_server_completion_resolve` |
| `language-provider#hover` | LSP `textDocument/hover` via `language_server_workspace_configuration` |
| `language-provider#diagnostics` | emitted by language server subprocess |
| `language-provider#format-document` | `language_server_formatting` |
| `grammar-provider#grammar-wasm` | `grammar` entry in `extension.toml` |
| `grammar-provider#highlights-query` | `highlights.scm` in extension bundle |
| `webview-provider` | not currently in Zed API — see cross-editor toolchain doc |
| `workspace#read-file` | `worktree.read_text_file` |
| `workspace#find-files` | `worktree.entries` |
| `workspace#get-config` | `settings_schema` / `language_server_workspace_configuration` |
| `ui#log` | `cx.emit` to output panel |
| `http#fetch` | `http_client` |

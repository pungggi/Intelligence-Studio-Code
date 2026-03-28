# CoreCode — Extension Compatibility Matrix

> **Status**: M12 (current)
> **Last updated**: 2026-03-28
> **Shim version**: M12 + vscode.tasks + vscode.scm + git API

## Legend

| Symbol | Meaning |
|:-------|:--------|
| ✅ Compatible | All required APIs present; extension activates and its primary features work |
| ⚠️ Partial | Activates, core features work, but secondary features are blocked by missing APIs |
| ❌ Incompatible | Cannot activate or core features require APIs not yet implemented |

---

## Top 58 Extensions

| # | Extension | Key APIs Required | Status | Blocking Gap |
|:--|:----------|:------------------|:-------|:-------------|
| 1 | **ESLint** `dbaeumer.vscode-eslint` | `createDiagnosticCollection`, `workspace.onDidSaveTextDocument`, `workspaceFolders`, `showInformationMessage` | ✅ Compatible | — |
| 2 | **Prettier** `esbenp.prettier-vscode` | `registerDocumentFormattingEditProvider`, `getConfiguration`, `workspace.onDidSaveTextDocument`, `showErrorMessage` | ✅ Compatible | — |
| 3 | **GitLens** `eamodio.gitlens` | `EventEmitter`, `Disposable`, `ThemeColor`, `ThemeIcon`, `MarkdownString`, `workspaceFolders`, `createStatusBarItem`, `env.openExternal`, `vscode.git` API | ✅ Compatible | — |
| 4 | **Python** `ms-python.python` | `createTerminal`, `workspaceFolders`, `registerCompletionItemProvider`, `EventEmitter`, `env.appRoot`, DAP | ✅ Compatible | — |
| 5 | **C/C++** `ms-vscode.cpptools` | `registerHoverProvider`, `registerDefinitionProvider`, `registerCompletionItemProvider`, `createOutputChannel`, `Disposable` | ✅ Compatible | — |
| 6 | **GitHub Copilot** `GitHub.copilot` | `EventEmitter`, `activeTextEditor`, `registerInlineCompletionItemProvider`, `onDidChangeTextDocument`, `env.sessionId` | ✅ Compatible | — |
| 7 | **Path IntelliSense** `christian-kohler.path-intellisense` | `registerCompletionItemProvider`, `workspaceFolders`, `getConfiguration` | ✅ Compatible | — |
| 8 | **Auto Rename Tag** `formulahendry.auto-rename-tag` | `onDidChangeTextDocument`, `activeTextEditor`, `Selection` | ✅ Compatible | — |
| 9 | **Bracket Pair Colorizer 2** `CoenraadS.bracket-pair-colorizer-2` | `createTextEditorDecorationType`, `activeTextEditor`, `Disposable` | ✅ Compatible | — |
| 10 | **indent-rainbow** `oderwat.indent-rainbow` | `createTextEditorDecorationType`, `activeTextEditor`, `onDidChangeTextDocument` | ✅ Compatible | — |
| 11 | **Material Icon Theme** `PKief.material-icon-theme` | `EventEmitter`, `getConfiguration` | ✅ Compatible | Icon associations applied to file tree |
| 12 | **Thunder Client** `rangav.vscode-thunder-client` | `createWebviewPanel`, `registerTreeDataProvider`, `EventEmitter`, `getConfiguration` | ✅ Compatible | WebView panels and tree views both supported |
| 13 | **REST Client** `humao.rest-client` | `showInformationMessage`, `createOutputChannel`, `getConfiguration`, `registerCompletionItemProvider` | ✅ Compatible | — |
| 14 | **Docker** `ms-azuretools.vscode-docker` | `createTreeView`, `registerTreeDataProvider`, `createTerminal`, `workspaceFolders`, `ThemeIcon`, `MarkdownString` | ✅ Compatible | Requires Docker daemon running; all API calls succeed |
| 15 | **Volar / Vue** `Vue.volar` | All LSP providers, `getConfiguration`, `EventEmitter`, `workspaceFolders` | ✅ Compatible | Full LSP path supported |
| 16 | **Tailwind CSS IntelliSense** `bradlc.vscode-tailwindcss` | `registerCompletionItemProvider`, `registerHoverProvider`, `getConfiguration`, `workspaceFolders`, `FileType` | ✅ Compatible | — |
| 17 | **Error Lens** `usernamehw.errorlens` | `languages.onDidChangeDiagnostics`, `createTextEditorDecorationType`, `activeTextEditor`, `EventEmitter` | ✅ Compatible | — |
| 18 | **Todo Tree** `Gruntfuggly.todo-tree` | `registerTreeDataProvider`, `createTextEditorDecorationType`, `workspaceFolders`, `workspace.findFiles`, `ThemeIcon` | ✅ Compatible | — |
| 19 | **CodeSnap** `adpyke.codesnap` | `createWebviewPanel`, `activeTextEditor`, `Selection`, `registerCommand` | ✅ Compatible | WebView panel with canvas screenshot supported |
| 20 | **Live Share** `ms-vsliveshare.vsliveshare` | `extensions.getExtension`, `env.openExternal`, `createStatusBarItem`, `EventEmitter` | ⚠️ Partial | Collaboration backend requires Live Share service (external proprietary); no crash |
| 21 | **Auto Close Tag** `formulahendry.auto-close-tag` | `onDidChangeTextDocument`, `activeTextEditor`, `getConfiguration` | ✅ Compatible | — |
| 22 | **Go** `golang.go` | `createTerminal`, `registerCompletionItemProvider`, `registerHoverProvider`, `registerDefinitionProvider`, `workspace.fs`, `vscode.debug`, `vscode.tasks` | ✅ Compatible | `vscode.tasks` implemented (M12); debugging (M9 DAP) and test runner all functional |
| 23 | **C#** `ms-dotnettools.csharp` | All LSP providers, `createOutputChannel`, `createTerminal`, `vscode.debug`, `vscode.tasks` | ✅ Compatible | `vscode.tasks` implemented (M12); OmniSharp/Roslyn LSP, debugging, and build tasks all functional |
| 24 | **Java Extension Pack** `vscjava.vscode-java-pack` | All LSP providers, `createTreeView`, `registerTreeDataProvider`, `vscode.debug`, `vscode.tasks` | ✅ Compatible | `vscode.tasks` implemented (M12); JDT LS, debugging, and maven/gradle tasks all functional |
| 25 | **Git Graph** `mhutchie.git-graph` | `createWebviewPanel`, `registerCommand`, `workspaceFolders`, `workspace.findFiles` | ✅ Compatible | — |
| 26 | **Jupyter** `ms-toolsai.jupyter` | `createWebviewPanel`, `registerNotebookSerializer`, `vscode.notebook`, `createOutputChannel` | ⚠️ Partial | `vscode.notebooks` API now stubbed (`createNotebookController`, `registerNotebookSerializer`, all types); notebook cell execution UI not yet rendered in canvas editor |
| 27 | **Remote - WSL** `ms-vscode-remote.remote-wsl` | `createTerminal`, `createStatusBarItem`, `env.remoteName`, `extensions.getExtension` | ⚠️ Partial | Full filesystem virtualization requires `RemoteAuthorityResolver` (not implemented) |
| 28 | **PowerShell** `ms-vscode.PowerShell` | `createTerminal`, `registerCompletionItemProvider`, `createOutputChannel`, `vscode.debug`, `vscode.tasks` | ✅ Compatible | `vscode.tasks` implemented (M12); LSP/REPL, debugging, and task execution all functional |
| 29 | **Markdown All in One** `yzhang.markdown-all-in-one` | `registerCompletionItemProvider`, `registerDocumentFormattingEditProvider`, `onDidChangeTextDocument`, `getConfiguration`, `registerCommand` | ✅ Compatible | — |
| 30 | **Better Comments** `aaron-bond.better-comments` | `createTextEditorDecorationType`, `activeTextEditor`, `onDidChangeTextDocument`, `getConfiguration` | ✅ Compatible | — |
| 31 | **Rainbow CSV** `mechatroner.rainbow-csv` | `createTextEditorDecorationType`, `registerHoverProvider`, `getConfiguration` | ✅ Compatible | — |
| 32 | **XML** `redhat.vscode-xml` | All LSP providers, `createOutputChannel`, `workspaceFolders`, `getConfiguration` | ✅ Compatible | Full LSP path; XML language server activates via LSP protocol |
| 33 | **YAML** `redhat.vscode-yaml` | All LSP providers, `getConfiguration`, `workspaceFolders`, `workspace.onDidChangeConfiguration` | ✅ Compatible | — |
| 34 | **Color Highlight** `naumovs.color-highlight` | `createTextEditorDecorationType`, `activeTextEditor`, `onDidChangeTextDocument` | ✅ Compatible | — |
| 35 | **DotENV** `mikestead.dotenv` | `getConfiguration` (syntax highlighting only) | ✅ Compatible | Grammar-based; no runtime API calls beyond activation |
| 36 | **WakaTime** `WakaTime.vscode-wakatime` | `onDidChangeTextDocument`, `onDidSaveTextDocument`, `activeTextEditor`, `createStatusBarItem` | ✅ Compatible | Telemetry sent to WakaTime service; requires API key in settings |
| 37 | **Code Spell Checker** `streetsidesoftware.code-spell-checker` | `createDiagnosticCollection`, `getConfiguration`, `onDidChangeTextDocument`, `workspaceFolders` | ✅ Compatible | — |
| 38 | **SonarLint** `SonarSource.sonarlint-vscode` | `createDiagnosticCollection`, `createOutputChannel`, `workspace.fs`, `workspaceFolders`, `getConfiguration`, `authentication` | ✅ Compatible | Static analysis works; connected mode (SonarQube/Cloud) requires matching SonarQube auth provider |
| 39 | **Import Cost** `wix.vscode-import-cost` | `createTextEditorDecorationType`, `activeTextEditor`, `workspace.fs`, `workspaceFolders` | ✅ Compatible | — |
| 40 | **Pylance** `ms-python.vscode-pylance` | All LSP providers, `createOutputChannel`, `workspaceFolders`, `getConfiguration` | ✅ Compatible | Full LSP path; Pylance language server activates; type checking and IntelliSense work |
| 41 | **IntelliCode** `VisualStudioExptTeam.vscodeintellicode` | `registerCompletionItemProvider`, `activeTextEditor`, `onDidChangeTextDocument`, `getConfiguration` | ⚠️ Partial | AI-ranked suggestions depend on telemetry collection env APIs not yet exposed |
| 42 | **GitHub Actions** `GitHub.vscode-github-actions` | `registerTreeDataProvider`, `createWebviewPanel`, `getConfiguration`, `authentication` | ✅ Compatible | GitHub Device Flow authentication works; workflow tree and logs functional |
| 43 | **Dart** `Dart-Code.dart-code` | All LSP providers, `createTerminal`, `vscode.debug`, `vscode.tasks`, `getConfiguration` | ✅ Compatible | `vscode.tasks` implemented (M12); LSP, debugging, and task-based test runner all functional |
| 44 | **Flutter** `Dart-Code.flutter` | All LSP providers, `createTerminal`, `vscode.debug`, `vscode.tasks`, `vscode.debug.registerDebugAdapterDescriptorFactory` | ✅ Compatible | `vscode.tasks` implemented (M12); hot reload terminal, debugging, and device picker tasks all functional |
| 45 | **GitHub Pull Requests** `GitHub.vscode-pull-request-github` | `createWebviewPanel`, `registerTreeDataProvider`, `authentication`, `vscode.comments`, `vscode.scm` | ✅ Compatible | `vscode.scm` (M12) and `vscode.comments` (M12) both implemented; PR creation/browsing and inline review comment threads all functional |
| 46 | **Vim** `vscodevim.vim` | `onDidChangeTextDocument`, `activeTextEditor`, `createStatusBarItem`, `getConfiguration`, `registerCommand`, `Selection` | ✅ Compatible | Vim key bindings active; status bar shows mode; normal/insert/visual modes work |
| 47 | **Even Better TOML** `tamasfe.even-better-toml` | All LSP providers, `getConfiguration`, `createOutputChannel` | ✅ Compatible | Full LSP path; taplo language server activates |
| 48 | **Svelte** `svelte.svelte-vscode` | All LSP providers, `getConfiguration`, `workspaceFolders`, `EventEmitter` | ✅ Compatible | Full LSP path; Svelte language server activates |
| 49 | **Remote - SSH** `ms-vscode-remote.remote-ssh` | `RemoteAuthorityResolver`, `workspace.fs` (virtual FS), `vscode.env.remoteName` | ❌ Incompatible | Core feature requires `RemoteAuthorityResolver` API + full virtual filesystem — not implemented |
| 50 | **Apollo GraphQL** `apollographql.vscode-apollo` | All LSP providers, `getConfiguration`, `workspaceFolders`, `createOutputChannel` | ✅ Compatible | Full LSP path; Apollo language server activates; schema introspection requires network access |
| 51 | **clangd** `llvm-vs-code-extensions.vscode-clangd` | All LSP providers, `registerInlayHintsProvider`, `registerRenameProvider`, `createOutputChannel`, `getConfiguration` | ✅ Compatible | Inlay hints and rename (F2) fully working (M10/M11) |
| 52 | **MQL Language** (clangd-based) `nicksahler.mql5` | All LSP providers, `getConfiguration`, `createOutputChannel` | ✅ Compatible | Follows standard clangd LSP path; MetaTrader `.mq5`/`.mq4` syntax and IntelliSense work |
| 53 | **AL Language** `ms-dynamics-nav.al` | All LSP providers, `createOutputChannel`, `workspaceFolders`, `getConfiguration`, `createTerminal` | ✅ Compatible | Business Central AL LSP activates via standard LSP path |
| 54 | **Augment Code** `augment.vscode-augment` | `registerCompletionItemProvider`, `activeTextEditor`, `onDidChangeTextDocument`, `createWebviewPanel`, `workspace.fs`, `createStatusBarItem` | ✅ Compatible | — |
| 55 | **Claude Code** `anthropic.claude-vscode` | `createWebviewPanel`, `registerCommand`, `createTerminal`, `activeTextEditor`, `workspace.fs`, `createStatusBarItem` | ✅ Compatible | — |
| 56 | **CodeRabbit** `coderabbit.ai` | `createWebviewPanel`, `registerCommand`, `registerTreeDataProvider`, `authentication`, `getConfiguration` | ✅ Compatible | GitHub authentication works; WebView panel and PR review tree functional |
| 57 | **Roo Code** `roo-cline.roo-cline` | `createWebviewPanel`, `workspace.fs`, `createTerminal`, `registerCommand`, `workspaceFolders`, `activeTextEditor` | ✅ Compatible | — |
| 58 | **Cline** `saoudrizwan.claude-dev` | `createWebviewPanel`, `workspace.fs`, `createTerminal`, `registerCommand`, `workspaceFolders`, `activeTextEditor` | ✅ Compatible | — |

---

## Summary

| Status | Count |
|:-------|:------|
| ✅ Compatible | 53 |
| ⚠️ Partial | 4 |
| ❌ Incompatible | 1 |

---

## Remaining API Gaps

| API | Blocked Extensions | Priority |
|:----|:------------------|:---------|
| `vscode.notebook` cell rendering UI | #26 Jupyter | P3 — canvas renderer needs notebook cell layout |
| `RemoteAuthorityResolver` | #49 Remote SSH | P4 — requires virtual FS infrastructure |

### Resolved gaps (previously listed, now implemented)

| API | Resolved in | Notes |
|:----|:-----------|:------|
| `workspace.fs` readFile/writeFile/stat | M8 | Backed by `node:fs/promises` in Extension Host |
| `workspace.findFiles(glob)` | M8 | Recursive fs walk with glob-to-regex conversion |
| `TextEditor.setDecorations` rendering | M8b | `paintDecorations()` canvas layer in editor.js |
| `vscode.debug` namespace | M9 | Full DAP session lifecycle implemented |
| `vscode.git` extension API | M9 | `createGitExtension` spawns real git binary |
| `vscode.authentication` (GitHub OAuth) | M10 | Device Flow with real HTTPS to github.com |
| Inlay hints rendering | M10 | Canvas overlay at character positions |
| `registerRenameProvider` (F2) | M11 | Full prepare→rename→applyEdit flow |
| `registerDocumentHighlightProvider` | M11 | Canvas highlight overlay, 300ms debounce |
| `window.showTextDocument` | M11 | Polled queue, supports selection jump |
| `vscode.tasks` (ShellExecution / ProcessExecution) | M12 | Real task execution via integrated terminal; fixes Go, C#, Java, PowerShell, Dart, Flutter |
| `vscode.scm` createSourceControl + resource groups | M12 | Proxy-based resourceStates push to Rust; SCM sidebar panel + diff viewer |
| `vscode.comments` createCommentController + threads | M12 | Proxy-based thread push to Rust; gutter indicators + popup; unblocks GitHub PRs inline review |

---

## Testing Protocol

For each extension in the matrix:

1. Install via Open VSX marketplace UI (Ctrl+Shift+X)
2. Reload the Extension Host (via Command Palette → "Reload Window" equivalent)
3. Open a relevant file type (`.js` for ESLint, `.py` for Python, etc.)
4. Verify activation: check Extension Host status in the status bar
5. Exercise primary feature (e.g., trigger a lint error, format a file, open a tree view)
6. Document result in this matrix

### Automated smoke test checklist

- [ ] ESLint: introduce a syntax error → red squiggle appears
- [ ] Prettier: `Ctrl+Shift+F` formats a JS file
- [ ] Path IntelliSense: type `./` in a string → path completions appear
- [ ] Auto Rename Tag: rename opening HTML tag → closing tag updates
- [ ] Auto Close Tag: type `<div` → closing `</div>` auto-inserted
- [ ] Material Icon Theme: open file tree → icons match file types
- [ ] Thunder Client: open Thunder Client view → tree view renders with collections
- [ ] REST Client: send a GET request → response appears in output
- [ ] Docker: open Docker view → container list renders (requires Docker daemon)
- [ ] Volar: open `.vue` file → completions and hover work
- [ ] Tailwind: open a file with Tailwind classes → class completions appear
- [ ] CodeSnap: run CodeSnap command → webview opens with code screenshot
- [ ] Vim: open a file → mode indicator in status bar, hjkl navigation works
- [ ] Go: open `.go` file → hover and completions from `gopls` work; F5 starts debugger
- [ ] Python: open `.py` file → completions work, terminal REPL launches, F5 debugger works
- [ ] Markdown All in One: open `.md` → table of contents renders, format works
- [ ] Code Spell Checker: introduce typo → yellow squiggle appears
- [ ] XML/YAML: open respective file → completions and validation work
- [ ] WakaTime: save a file → activity logged (requires API key)
- [ ] Pylance: open `.py` file → type info in hover, import completions
- [ ] GitLens: open a git repo → blame annotations and git decorations appear
- [ ] Error Lens: introduce a diagnostic error → inline annotation appears on the line
- [ ] Todo Tree: open workspace with TODO comments → tree view populates
- [ ] Better Comments: add `// ! warning` comment → coloured decoration appears
- [ ] Cline / Roo Code: open panel → file read/write agent tasks work
- [ ] GitHub Actions: open workflow tree → workflow runs listed (requires GitHub auth)
- [ ] clangd: open `.cpp` file → inlay hints render, F2 rename works
- [ ] Go: run `tasks.fetchTasks()` → build/test tasks listed; `tasks.executeTask()` opens terminal and runs command
- [ ] C#: build task via Command Palette → `dotnet build` terminal opens
- [ ] Java: maven/gradle build task runs in terminal
- [ ] PowerShell: PSake/Invoke-Build tasks execute in terminal
- [ ] Dart/Flutter: `pub run` test tasks execute via terminal
- [ ] GitHub PRs: open PR view → source control panel shows PR branches; open a PR with review comments → blue gutter bars appear at commented lines; click bar → comment popup shows author + body

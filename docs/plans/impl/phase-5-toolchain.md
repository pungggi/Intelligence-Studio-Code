# Phase 5 — Cross-Editor Build Toolchain

**Goal:** `cargo corecode build --target all` produces a CoreCode `.ccext`, a Zed `.zip`,
and a VS Code `.vsix` from the same Rust source.

**Depends on:** Phase 1–4 complete (all exports implemented in the WASM binary)

---

## 1. Repository structure for `cargo-corecode`

The CLI lives in a separate crate, **not** inside `corecode-app`. This crate is published
to crates.io as `cargo-corecode` and installed by extension developers with:

```sh
cargo install cargo-corecode
```

Create:

```
tools/cargo-corecode/
  Cargo.toml
  src/
    main.rs           ← CLI entry point (clap)
    commands/
      new.rs          ← scaffold new extension project
      build.rs        ← build command router
      check.rs        ← compatibility check
      publish.rs      ← publish to CoreCode marketplace
    packagers/
      corecode.rs     ← produce .ccext
      zed.rs          ← produce Zed .zip
      vscode.rs       ← produce .vsix
    adapter/
      vscode_js.rs    ← generate dist/extension.js
      bridge_vscode.rs ← VS Code variant of corecode-bridge.js
    wit/
      compat.rs       ← WIT version → target API mapping
```

`Cargo.toml` (tools/cargo-corecode):

```toml
[package]
name    = "cargo-corecode"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "cargo-corecode"
path = "src/main.rs"

[dependencies]
clap      = { version = "4", features = ["derive"] }
anyhow    = "1"
serde     = { version = "1", features = ["derive"] }
serde_json = "1"
toml      = "0.8"
zip       = "2"
walkdir   = "2"
wit-parser = "0.210"   # for WIT validation in `check`
```

---

## 2. CLI entry point

`src/main.rs`:

```rust
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "cargo", bin_name = "cargo")]
enum Cargo {
    #[command(name = "corecode")]
    CoreCode(CoreCodeArgs),
}

#[derive(Parser)]
struct CoreCodeArgs {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Scaffold a new extension project
    New {
        name: String,
        #[arg(long, default_value = "language-provider")]
        template: String,
    },
    /// Build extension packages
    Build {
        #[arg(long, default_value = "corecode")]
        target: String,    // "corecode" | "zed" | "vscode" | "all"
        #[arg(long)]
        release: bool,
    },
    /// Check WIT API compatibility for each target
    Check {
        #[arg(long, default_value = "all")]
        target: String,
    },
    /// Publish to the CoreCode marketplace
    Publish {
        #[arg(long)]
        token: Option<String>,
    },
}

fn main() -> anyhow::Result<()> {
    let Cargo::CoreCode(args) = Cargo::parse();
    match args.command {
        Command::New { name, template } => commands::new::run(&name, &template),
        Command::Build { target, release } => commands::build::run(&target, release),
        Command::Check { target } => commands::check::run(&target),
        Command::Publish { token } => commands::publish::run(token.as_deref()),
    }
}
```

---

## 3. `commands/build.rs`

```rust
fn load_corecode_manifest() -> anyhow::Result<CoreCodeManifest> {
    let text = std::fs::read_to_string("corecode.toml")
        .context("Cannot read corecode.toml — run this command from your extension's root directory")?;
    toml::from_str::<CoreCodeManifest>(&text)
        .context("Failed to parse corecode.toml")
}

pub fn run(target: &str, release: bool) -> anyhow::Result<()> {
    let manifest = load_corecode_manifest()?;

    let cargo_manifest: toml::Value = toml::from_str(
        &std::fs::read_to_string("Cargo.toml")?
    )?;
    let pkg_name = cargo_manifest["package"]["name"]
        .as_str().unwrap_or("extension")
        .replace('-', "_");

    let wasm_path = compile_wasm(release, &pkg_name)?;

    match target {
        "corecode" => packagers::corecode::pack(&manifest, &wasm_path)?,
        "zed"      => packagers::zed::pack(&manifest, &wasm_path)?,
        "vscode"   => packagers::vscode::pack(&manifest, &wasm_path)?,
        "all" => {
            packagers::corecode::pack(&manifest, &wasm_path)?;
            packagers::zed::pack(&manifest, &wasm_path)?;
            packagers::vscode::pack(&manifest, &wasm_path)?;
        }
        _ => anyhow::bail!("Unknown target: {target}. Use corecode, zed, vscode, or all"),
    }
    Ok(())
}

fn compile_wasm(release: bool, pkg_name: &str) -> anyhow::Result<std::path::PathBuf> {
    let mut cmd = std::process::Command::new("cargo");
    cmd.args(["build", "--target", "wasm32-wasi"]);
    if release { cmd.arg("--release"); }

    let status = cmd.status()?;
    if !status.success() {
        anyhow::bail!("cargo build failed");
    }

    let profile = if release { "release" } else { "debug" };

    Ok(std::path::PathBuf::from(format!(
        "target/wasm32-wasi/{profile}/{pkg_name}.wasm"
    )))
}
```

---

## 4. `packagers/corecode.rs`

```rust
pub fn pack(manifest: &CoreCodeManifest, wasm_path: &Path) -> anyhow::Result<()> {
    let out_name = format!("{}-{}.ccext", manifest.extension.id, manifest.extension.version);
    let out = std::fs::File::create(&out_name)?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default();

    // corecode.toml
    zip.start_file("corecode.toml", opts)?;
    zip.write_all(&std::fs::read("corecode.toml")?)?;

    // extension.wasm
    zip.start_file("extension.wasm", opts)?;
    zip.write_all(&std::fs::read(wasm_path)?)?;

    // webview/ directory (if present)
    if Path::new("webview").is_dir() {
        for entry in walkdir::WalkDir::new("webview").min_depth(1) {
            let entry = entry?;
            if entry.file_type().is_file() {
                let rel = entry.path().to_string_lossy();
                zip.start_file(rel.as_ref(), opts)?;
                zip.write_all(&std::fs::read(entry.path())?)?;
            }
        }
    }

    zip.finish()?;
    println!("✓ CoreCode package: {out_name}");
    Ok(())
}
```

---

## 5. `packagers/zed.rs`

The Zed packager generates `extension.toml` from `corecode.toml` and mirrors
the webview-less subset:

```rust
pub fn pack(manifest: &CoreCodeManifest, wasm_path: &Path) -> anyhow::Result<()> {
    let out_name = format!("{}-{}-zed.zip", manifest.extension.id, manifest.extension.version);
    let out = std::fs::File::create(&out_name)?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default();

    // Generate extension.toml
    let ext_toml = generate_zed_manifest(manifest);
    zip.start_file("extension.toml", opts)?;
    zip.write_all(ext_toml.as_bytes())?;

    // Same WASM binary
    zip.start_file("extension.wasm", opts)?;
    zip.write_all(&std::fs::read(wasm_path)?)?;

    // Grammar files (if grammar is declared)
    if let Some(grammar) = &manifest.grammar {
        // highlights.scm — generated by calling the WASM binary's highlights_query export
        let highlights = extract_highlights_query(wasm_path, grammar)?;
        let path = format!("languages/{}/highlights.scm", grammar.language_id);
        zip.start_file(&path, opts)?;
        zip.write_all(highlights.as_bytes())?;

        if let Some(injections) = extract_injections_query(wasm_path, grammar)? {
            let path = format!("languages/{}/injections.scm", grammar.language_id);
            zip.start_file(&path, opts)?;
            zip.write_all(injections.as_bytes())?;
        }
    }

    zip.finish()?;
    println!("✓ Zed package: {out_name}");
    println!("  ⚠ webview-provider not supported in Zed — panel features excluded");
    Ok(())
}

/// Extract the highlights.scm query embedded in the WASM binary.
/// Parses the WASM custom sections to locate `queries/{language_id}/highlights.scm`.
fn extract_highlights_query(
    wasm_path: &std::path::Path,
    grammar: &Grammar,
) -> anyhow::Result<String> {
    use wasmparser::{Parser, Payload};
    let bytes = std::fs::read(wasm_path)?;
    let target = format!("queries/{}/highlights.scm", grammar.language_id);
    for payload in Parser::new(0).parse_all(&bytes) {
        if let Payload::CustomSection(reader) = payload? {
            if reader.name() == target {
                return Ok(std::str::from_utf8(reader.data())?.to_string());
            }
        }
    }
    anyhow::bail!("highlights.scm not found in WASM binary for '{}'", grammar.language_id)
}

/// Extract the injections.scm query, or None if not present.
fn extract_injections_query(
    wasm_path: &std::path::Path,
    grammar: &Grammar,
) -> anyhow::Result<Option<String>> {
    use wasmparser::{Parser, Payload};
    let bytes = std::fs::read(wasm_path)?;
    let target = format!("queries/{}/injections.scm", grammar.language_id);
    for payload in Parser::new(0).parse_all(&bytes) {
        if let Payload::CustomSection(reader) = payload? {
            if reader.name() == target {
                return Ok(Some(std::str::from_utf8(reader.data())?.to_string()));
            }
        }
    }
    Ok(None)
}

fn generate_zed_manifest(manifest: &CoreCodeManifest) -> String {
    let mut s = String::new();
    s.push_str("[extension]\n");
    s.push_str(&format!("id = {:?}\n", manifest.extension.id));
    s.push_str(&format!("name = {:?}\n", manifest.extension.name));
    s.push_str(&format!("version = {:?}\n", manifest.extension.version));
    s.push_str("schema_version = 1\n");

    if let Some(grammar) = &manifest.grammar {
        s.push_str(&format!("\n[grammars.{}]\n", grammar.language_id));
        s.push_str("repository = \"\"\n");

        s.push_str(&format!("\n[language_servers.{}]\n", grammar.language_id));
        s.push_str(&format!("language = {:?}\n", grammar.language_id));
        // Command field: extension provides its own language server via WASM exports
        s.push_str(&format!("command = {{ extension = {:?} }}\n", grammar.language_id));
    }
    s
}
```

---

## 6. `packagers/vscode.rs`

The VS Code packager is the most complex: it generates the adapter JS.

```rust
pub fn pack(manifest: &CoreCodeManifest, wasm_path: &Path) -> anyhow::Result<()> {
    let out_name = format!("{}-{}.vsix", manifest.extension.id, manifest.extension.version);
    let out = std::fs::File::create(&out_name)?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default();

    // extension/package.json
    let pkg_json = generate_vscode_package_json(manifest);
    zip.start_file("extension/package.json", opts)?;
    zip.write_all(pkg_json.as_bytes())?;

    // extension/dist/extension.js (the generated adapter)
    let adapter_js = adapter::vscode_js::generate(manifest);
    zip.start_file("extension/dist/extension.js", opts)?;
    zip.write_all(adapter_js.as_bytes())?;

    // extension/dist/extension.wasm
    zip.start_file("extension/dist/extension.wasm", opts)?;
    zip.write_all(&std::fs::read(wasm_path)?)?;

    // extension/webview/ with VS Code bridge variant
    if Path::new("webview").is_dir() {
        for entry in walkdir::WalkDir::new("webview").min_depth(1) {
            let entry = entry?;
            if entry.file_type().is_file() {
                let name = entry.file_name().to_string_lossy();
                // Swap corecode-bridge.js for the VS Code variant
                if name == "corecode-bridge.js" { continue; }
                let path = format!("extension/{}", entry.path().to_string_lossy());
                zip.start_file(&path, opts)?;
                zip.write_all(&std::fs::read(entry.path())?)?;
            }
        }
        // Inject the VS Code bridge
        zip.start_file("extension/webview/corecode-bridge.js", opts)?;
        zip.write_all(adapter::bridge_vscode::BRIDGE.as_bytes())?;
    }

    zip.finish()?;
    println!("✓ VS Code package: {out_name}");
    Ok(())
}

fn generate_vscode_package_json(manifest: &CoreCodeManifest) -> String {
    let lang_ids: Vec<&str> = manifest.languages.iter()
        .filter(|(_, &v)| v)
        .map(|(k, _)| k.as_str())
        .collect();

    let activation_events: Vec<String> = lang_ids.iter()
        .map(|l| format!("onLanguage:{l}"))
        .collect();

    serde_json::to_string_pretty(&serde_json::json!({
        "name": manifest.extension.id.split('.').last().unwrap_or(&manifest.extension.id),
        "displayName": manifest.extension.name,
        "publisher": manifest.extension.id.split('.').next().unwrap_or("unknown"),
        "version": manifest.extension.version,
        "engines": { "vscode": "^1.75.0" },
        "categories": ["Other"],
        "activationEvents": activation_events,
        "contributes": {},
        "main": "./dist/extension.js",
        "extensionKind": ["workspace"]
    })).unwrap_or_default()
}
```

---

## 7. `adapter/vscode_js.rs` — adapter generator

Generates the full `dist/extension.js` Node.js adapter:

```rust
pub fn generate(manifest: &CoreCodeManifest) -> String {
    let lang_registrations = if !manifest.languages.is_empty() {
        generate_language_registrations(&manifest.languages)
    } else {
        String::new()
    };

    let webview_code = if manifest.capabilities.webview_panels {
        generate_webview_code()
    } else {
        String::new()
    };

    format!(r#"
// GENERATED by cargo-corecode — do not edit
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

let ext;
const channels = {{}};
const statusItems = {{}};
const panels = {{}};

export async function activate(context) {{
  const wasmBytes = fs.readFileSync(path.join(context.extensionPath, 'dist', 'extension.wasm'));

  // Instantiate the WASM component with host imports
  const {{ instance }} = await WebAssembly.instantiate(wasmBytes, {{
    'corecode:extension/ui': {{
      log(channel, message) {{
        channels[channel] = channels[channel] ?? vscode.window.createOutputChannel(channel);
        channels[channel].appendLine(message);
      }},
      'show-message'(level, message) {{
        const fns = {{ info: 'showInformationMessage', warning: 'showWarningMessage', error: 'showErrorMessage' }};
        vscode.window[fns[level] ?? 'showInformationMessage']?.(message);
      }},
      'set-status'(id, text, tooltip) {{
        if (!text) {{ statusItems[id]?.dispose(); delete statusItems[id]; return; }}
        statusItems[id] = statusItems[id] ?? vscode.window.createStatusBarItem();
        statusItems[id].text = text;
        statusItems[id].tooltip = tooltip ?? '';
        statusItems[id].show();
      }},
    }},
    'corecode:extension/workspace': {{
      async 'read-file'(p) {{
        if (!vscode.workspace.workspaceFolders?.length) {{
          throw new Error('No workspace folder open');
        }}
        const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, p);
        const bytes = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(bytes);
      }},
      async 'find-files'(glob) {{
        const uris = await vscode.workspace.findFiles(glob);
        return uris.map(u => u.toString());
      }},
      'root-uri'() {{ return vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? ''; }},
      'get-config'(key) {{
        const parts = key.split('.');
        const section = parts.slice(0, -1).join('.');
        const item = parts[parts.length - 1];
        const val = vscode.workspace.getConfiguration(section).get(item);
        return val !== undefined ? String(val) : undefined;
      }},
    }},
    {webview_code}
  }});

  ext = instance.exports;
  const result = ext['corecode:extension/lifecycle'].activate();
  if (result.tag === 'err') throw new Error(result.val);

  {lang_registrations}
  context.subscriptions.push({{ dispose: () => ext['corecode:extension/lifecycle'].deactivate() }});
}}

export function deactivate() {{}}
"#,
        webview_code = webview_code,
        lang_registrations = lang_registrations,
    )
}

fn generate_language_registrations(langs: &std::collections::HashMap<String, bool>) -> String {
    let lang_ids: Vec<&str> = langs.iter()
        .filter(|(_, &v)| v)
        .map(|(k, _)| k.as_str())
        .collect();

    format!(r#"
  const langFilter = [{lang_list}];
  const lp = ext['corecode:extension/language-provider'];
  if (lp) {{
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(langFilter, {{
        provideCompletionItems(doc, pos, _tok, ctx) {{
          const r = lp.completions(doc.uri.toString(),
            {{ line: pos.line, character: pos.character }},
            ctx.triggerCharacter ?? null);
          if (r.tag === 'err') return [];
          return r.val.map(item => {{
            const ci = new vscode.CompletionItem(item.label);
            ci.insertText = item['insert-text'];
            ci.detail = item.detail ?? undefined;
            ci.documentation = item.documentation ?? undefined;
            return ci;
          }});
        }}
      }}),
      vscode.languages.registerHoverProvider(langFilter, {{
        provideHover(doc, pos) {{
          const r = lp.hover(doc.uri.toString(),
            {{ line: pos.line, character: pos.character }});
          if (r.tag === 'err' || !r.val) return null;
          return new vscode.Hover(r.val.contents);
        }}
      }}),
      // ... registerDocumentFormattingEditProvider, registerDefinitionProvider, etc.
    );
  }}
"#,
        lang_list = lang_ids.iter().map(|l| format!("{l:?}")).collect::<Vec<_>>().join(", "),
    )
}

/// Returns the JS source for injectVsCodeBridge as a string,
/// to be embedded in the generated VS Code adapter.
fn inject_vscode_bridge_js() -> &'static str {
    r#"function injectVsCodeBridge(html, webview, context) {
  const bridgeUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'webview', 'corecode-bridge.js')
  );
  const scriptTag = `<script src="${bridgeUri}"></script>`;
  const headClose = html.indexOf('</head>');
  if (headClose !== -1) {
    return html.slice(0, headClose) + scriptTag + html.slice(headClose);
  }
  const bodyClose = html.indexOf('</body>');
  if (bodyClose !== -1) {
    return html.slice(0, bodyClose) + scriptTag + html.slice(bodyClose);
  }
  return html + scriptTag;
}"#
}

fn generate_webview_code() -> String {
    r#"'corecode:extension/webview-host': {
      'open-panel'(panelId, title, column) {
        const wp = ext['corecode:extension/webview-provider'];
        if (!wp) return { tag: 'err', val: 'no webview-provider export' };
        const html = wp['get-html'](panelId, null);
        const panel = vscode.window.createWebviewPanel(
          panelId, title, vscode.ViewColumn[column] ?? vscode.ViewColumn.One,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        // Inject VS Code bridge into HTML
        panel.webview.html = injectVsCodeBridge(html, panel.webview);
        panel.webview.onDidReceiveMessage(msg => {
          const response = wp['on-message'](panelId, JSON.stringify(msg));
          if (response) panel.webview.postMessage(JSON.parse(response));
        });
        panel.onDidDispose(() => {
          wp['on-close'](panelId);
          delete panels[panelId];
        });
        panels[panelId] = panel;
        return { tag: 'ok', val: undefined };
      },
      'post-to-webview'(panelId, json) {
        panels[panelId]?.webview.postMessage(JSON.parse(json));
        return { tag: 'ok', val: undefined };
      },
      'close-panel'(panelId) {
        panels[panelId]?.dispose();
        delete panels[panelId];
      },
    },"#.to_string()
}
```

---

## 8. `adapter/bridge_vscode.rs`

```rust
pub const BRIDGE: &str = r#"
// corecode-bridge.js — VS Code variant (generated into .vsix)
(function () {
  'use strict';
  const vscodeApi = acquireVsCodeApi();

  window.coreCode = {
    postMessage: function (data) {
      vscodeApi.postMessage(data);
    },
    request: function (data) {
      return new Promise(function (resolve) {
        const id = Math.random().toString(36).slice(2);
        const wrapped = Object.assign({}, data, { __requestId: id });
        const handler = function (event) {
          if (event.data && event.data.__requestId === id) {
            window.removeEventListener('message', handler);
            resolve(event.data);
          }
        };
        window.addEventListener('message', handler);
        vscodeApi.postMessage(wrapped);
      });
    },
  };
})();
"#;
```

---

## 9. `commands/check.rs`

Validates the WASM binary's exports against each target's supported API subset
without compiling to a package:

```rust
pub fn run(target: &str) -> anyhow::Result<()> {
    let manifest = load_corecode_manifest()?;
    let wasm_path = find_wasm_binary()?;   // look in target/wasm32-wasi/

    let exports = inspect_wasm_exports(&wasm_path)?;

    for t in targets_from_arg(target) {
        let (supported, warnings) = wit::compat::check(&exports, &manifest, t);
        println!("{t}  {}", if supported { "✓" } else { "✗ incompatible" });
        for w in &warnings {
            println!("  ⚠ {w}");
        }
    }
    Ok(())
}

/// Search target/wasm32-wasi/ for the compiled .wasm binary.
fn find_wasm_binary() -> anyhow::Result<std::path::PathBuf> {
    for profile in &["release", "debug"] {
        let manifest: toml::Value = toml::from_str(&std::fs::read_to_string("Cargo.toml")?)?;
        let pkg_name = manifest["package"]["name"]
            .as_str().unwrap_or("extension")
            .replace('-', "_");
        let path = std::path::PathBuf::from(format!("target/wasm32-wasi/{profile}/{pkg_name}.wasm"));
        if path.exists() { return Ok(path); }
    }
    anyhow::bail!("No wasm32-wasi binary found. Run `cargo build --target wasm32-wasi` first.")
}

/// Parse export names from a WASM binary using wasmparser.
fn inspect_wasm_exports(wasm_path: &std::path::Path) -> anyhow::Result<Vec<String>> {
    use wasmparser::{Parser, Payload};
    let bytes = std::fs::read(wasm_path)?;
    let mut exports = Vec::new();
    for payload in Parser::new(0).parse_all(&bytes) {
        if let Payload::ExportSection(reader) = payload? {
            for export in reader {
                let export = export?;
                exports.push(export.name.to_string());
            }
        }
    }
    Ok(exports)
}

fn targets_from_arg(target: &str) -> Vec<&'static str> {
    match target {
        "all" => vec!["corecode", "zed", "vscode"],
        "corecode" => vec!["corecode"],
        "zed" => vec!["zed"],
        "vscode" => vec!["vscode"],
        _ => vec![],
    }
}

mod wit {
    pub mod compat {
        pub fn check(exports: &[String], _manifest: &super::super::CoreCodeManifest, target: &str)
            -> (bool, Vec<String>)
        {
            let mut warnings = Vec::new();
            let supported = match target {
                "zed" => {
                    if exports.contains(&"webview-provider".to_string()) {
                        warnings.push("webview-provider — not supported in Zed (will be excluded)".to_string());
                    }
                    true
                }
                "vscode" => true,
                _ => true,
            };
            (supported, warnings)
        }
    }
}
```

---

## 10. `commands/new.rs` — project scaffolding

Generates a minimal extension project with the right `Cargo.toml`, `corecode.toml`, and source:

```
cargo corecode new my-formatter --template format-provider
```

Templates:

| `--template` | What it creates |
|:-------------|:----------------|
| `language-provider` | Full language provider (completions, hover, diagnostics, format) |
| `format-provider` | Format-only (no completions or hover) |
| `grammar` | Grammar + highlights.scm only |
| `webview` | Hello World webview panel |
| `lsp-proxy` | Spawns an LSP subprocess and proxies calls |

Each template includes:
- `Cargo.toml` with `corecode-extension-api` dependency
- `corecode.toml` with minimal capabilities
- `src/lib.rs` with the relevant WIT exports stubbed out
- A `README.md` with build instructions

```rust
pub fn run(name: &str, template: &str) -> anyhow::Result<()> {
    use std::fs;
    let dir = std::path::Path::new(name);
    anyhow::ensure!(!dir.exists(), "Directory '{}' already exists", name);
    fs::create_dir_all(dir.join("src"))?;

    // Cargo.toml
    fs::write(dir.join("Cargo.toml"), format!(r#"[package]
name    = "{name}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wit-bindgen = "0.26"
corecode-extension-api = "0.1"
"#))?;

    // corecode.toml
    fs::write(dir.join("corecode.toml"), format!(r#"[extension]
id      = "my-publisher.{name}"
name    = "{name}"
version = "0.1.0"

[entry]
wasm = "{name}.wasm"

[capabilities]
workspace_read = false
network_fetch  = false
webview_panels = false
"#))?;

    // src/lib.rs based on template
    let lib_rs = match template {
        "language-provider" => include_str!("../templates/language_provider.rs"),
        "format-provider"   => include_str!("../templates/format_provider.rs"),
        "grammar"           => include_str!("../templates/grammar.rs"),
        "webview"           => include_str!("../templates/webview.rs"),
        _                   => include_str!("../templates/language_provider.rs"),
    };
    fs::write(dir.join("src/lib.rs"), lib_rs)?;

    println!("Created extension '{name}' with template '{template}'");
    println!("Build: cargo build --target wasm32-wasi --release");
    Ok(())
}
```

---

## 11. Testing the toolchain

```sh
# In examples/simple-lsp/
cargo corecode check --target all
# Expected output:
# corecode  ✓ all interfaces supported
# zed       ✓ language-provider
#           ⚠ webview-provider — not supported in Zed (excluded)
# vscode    ✓ language-provider, webview-provider

cargo corecode build --target all
# Expected output:
# ✓ CoreCode package: corecode.simple-lsp-0.1.0.ccext
# ✓ Zed package:     corecode.simple-lsp-0.1.0-zed.zip
# ✓ VS Code package: corecode.simple-lsp-0.1.0.vsix
```

Manual verification:
1. Install `.ccext` in CoreCode → extension activates, completions work
2. Install `.zip` in Zed → extension activates, language server starts
3. Install `.vsix` in VS Code (`code --install-extension ...`) → extension activates

---

## 12. Acceptance criteria

- `cargo corecode new` generates a buildable project for each template
- `cargo corecode build --target all` produces all three packages without errors
- `cargo corecode check` correctly flags `webview-provider` as unsupported in Zed
- The VS Code `.vsix` installs and provides completions in VS Code without modification
- The Zed `.zip` installs and provides highlighting in Zed without modification
- The CoreCode `.ccext` is identical to a manually assembled package

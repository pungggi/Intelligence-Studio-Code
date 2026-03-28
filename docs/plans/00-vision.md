# CoreCode Native Extension System — Vision & Goals

> **Status**: Planning
> **Created**: 2026-03-28

---

## Problem

CoreCode currently runs VS Code extensions via a Node.js extension host with a `vscode.*` API shim.
This works well for the existing VS Code ecosystem but has three limitations:

1. **Extensions must be written in JavaScript/TypeScript.** There is no path for a developer who
   wants to write extension logic in Rust, Go, or any other compiled language.

2. **No portability story.** An extension written for CoreCode only runs in CoreCode. There is no
   way to target Zed or any other editor with the same source.

3. **Webviews are VS Code-specific.** The `vscode.window.createWebviewPanel` API carries a decade
   of VS Code-specific scaffolding (CSP management, `retainContextWhenHidden`, `enableScripts`,
   `acquireVsCodeApi`). A developer who wants a custom UI panel is locked into the VS Code model.

---

## Goal

Add a second, parallel extension host to CoreCode that:

1. **Accepts extensions compiled to WebAssembly (`wasm32-wasi`).**
   Extensions can be written in any language that compiles to WASM — Rust being the primary target.

2. **Exposes a small, stable WIT API** that covers the most-used ~20% of editor extension
   functionality plus webview panels.

3. **Is portable.** The same WASM binary and the same webview HTML/JS can be packaged and
   published for CoreCode, Zed, and VS Code without rewriting the extension logic.

4. **Runs alongside the Node.js host.** The existing VS Code ecosystem is unaffected.
   Both hosts run simultaneously; extensions declare which host they target.

---

## Non-goals

- **Replacing the Node.js host.** VS Code extensions continue to work exactly as today.
- **Full VS Code API parity in WIT.** The WIT API is intentionally narrow. Developers who need
  the full VS Code surface use the Node.js host.
- **Runtime API bridging between the two hosts.** Extensions target one host. There is no
  mechanism to call VS Code APIs from a WASM extension or vice-versa.
- **Supporting every Zed extension API.** Zed compatibility is achieved by keeping the WIT
  definitions aligned with Zed's published interfaces, not by forking Zed's host code.

---

## Success criteria

| Criterion | Measure |
|:----------|:--------|
| A Rust extension activates in CoreCode | WASM binary loads, `activate()` called |
| LSP-backed completions work end-to-end | Rust Analyzer shim extension returns completion items |
| Webview panel opens and exchanges messages | Custom HTML panel renders, postMessage round-trip works |
| Same WASM binary runs in Zed | Extension installs and activates in Zed 0.x |
| Same source builds a VS Code `.vsix` | Build tool produces a working VS Code extension package |
| Node.js extensions unaffected | All M12 compatibility matrix entries unchanged |

# CoreCode Native Extension System — Webview Bridge

> **Status**: Planning
> **Created**: 2026-03-28

---

## Overview

Webview panels in the WASM extension model follow a clean separation:

```
┌─── WASM extension (Rust) ───────────────────────────────┐
│  get-html(panel-id) → "<html>...</html>"                 │
│  on-message(panel-id, json) → option<json>               │
│  on-close(panel-id)                                      │
└──────────────────────────────────────────────────────────┘
         ▲ host calls these WIT exports
         │
┌─── WASM host (Tauri/Rust) ──────────────────────────────┐
│  Opens Tauri WebviewWindow                               │
│  Injects corecode-bridge.js into the HTML                │
│  Routes postMessage ↔ WIT calls                          │
└──────────────────────────────────────────────────────────┘
         ▲ Tauri IPC
         │
┌─── Webview HTML/JS ──────────────────────────────────────┐
│  window.coreCode.postMessage({ type: "...", ... })        │
│  window.addEventListener("message", handler)              │
└──────────────────────────────────────────────────────────┘
```

The extension never touches the DOM. The HTML/JS is untrusted content rendered in a sandboxed
webview. The extension logic (WASM) handles messages and returns responses.

---

## Message flow

### Extension → webview (push)

```
Rust extension calls:
  webview-host#post-to-webview(panel-id, json)
    │
    ▼
WASM host receives the WIT call
    │
    ▼
host calls Tauri webview evaluate_script():
  window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(json) }))
    │
    ▼
Webview JS event listener fires
```

**Security note:** The host must safely serialize the JSON payload when building the
`evaluate_script` call. Use `serde_json::to_string(&value)` to produce a canonical JSON
string, then embed it as:
`window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(${escaped_json}) }))`
where `escaped_json` is the output of `serde_json::to_string`. This ensures no arbitrary
code can be injected via the payload.

### Webview → extension (request/response)

```
Webview JS calls:
  window.coreCode.postMessage({ type: "myAction", payload: {...} })
    │
    ▼
Tauri IPC handler receives the message (invoke handler)
    │
    ▼
WASM host calls extension WIT export:
  webview-provider#on-message(panel-id, json)
    │
    ▼
Extension returns option<string> (JSON response or null)
    │
    ▼
If response is Some(json):
  host dispatches response back to webview JS
  window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(json) }))
```

The bridge implementation in Phase 4 adds a `window.coreCode.request()` helper that attaches
a `__requestId` to each outgoing message and returns a Promise that resolves when the extension's
response includes the same `__requestId`. This enables clean async request/response patterns
without manual correlation logic in the extension's panel JS.

See the bridge script in Phase 4 (`corecode-bridge.js`) for the full implementation including
the `request()` helper with correlation IDs.

---

## The injected bridge script

The WASM host inlines the bridge script directly into the HTML before `</head>`, rather than
serving it as an external file. This avoids the need for a file:// or custom protocol handler
for the bridge. The extension's `get-html` return value is wrapped at injection time:

```html
<!-- Original extension HTML -->
<html>
  <head>
    <!-- INJECTED by host (inline, not external file): -->
    <script>window.__CORECODE_PANEL_ID__ = "panel-id-here";</script>
    <script>/* corecode-bridge.js contents inlined here */</script>
    <!-- end injection -->
    <script src="panel.js"></script>
  </head>
  <body>...</body>
</html>
```

`corecode-bridge.js` exposes a single global:

```js
// corecode-bridge.js (injected by host, not shipped by extension)
window.coreCode = {
  postMessage(data) {
    // In CoreCode: uses Tauri's invoke IPC
    window.__TAURI__.invoke('webview_message', {
      panelId: window.__CORECODE_PANEL_ID__,
      json: JSON.stringify(data),
    });
  }
};
```

`window.__CORECODE_PANEL_ID__` is a string constant injected by the host per-panel.

---

## Cross-editor webview compatibility

The webview HTML/JS written by the extension developer is identical across editors.
The only platform-specific piece is the `window.coreCode.postMessage` bridge, which is
provided by the host — the extension developer never writes it.

The cross-editor build tool (see `04-cross-editor-toolchain.md`) swaps the bridge
implementation per target:

| Target | Bridge implementation |
|:-------|:---------------------|
| CoreCode | `window.__TAURI__.invoke(...)` |
| Zed | Zed's `postMessage` IPC (injected by Zed's host) |
| VS Code wrapper | `const vscodeApi = acquireVsCodeApi(); vscodeApi.postMessage(...)` |

The extension developer writes:

```js
// panel.js — works in all three editors
window.coreCode.postMessage({ type: 'getCompletions', query: 'foo' });

window.addEventListener('message', (event) => {
  const data = event.data;
  if (data.type === 'completions') {
    renderList(data.items);
  }
});
```

The host provides `window.coreCode` regardless of editor. The extension developer writes
against that abstraction exclusively.

---

## Asset bundling

Extension webview assets are bundled inside `extension.wasm` using Rust's `include_str!` macro:

```rust
// In the extension source (Rust)
impl WebviewProvider for Extension {
    fn get_html(&self, _panel_id: &str, _state: Option<&str>) -> String {
        // Assets compiled into the binary at build time
        include_str!("../webview/panel.html").to_string()
    }
}
```

For larger assets (e.g. a full React app), the build tool converts the compiled JS bundle
to a `data:` URI embedded in the HTML, so the entire panel is self-contained in the WASM binary.
No separate file serving is required.

Alternative: for extensions that ship assets as sidecar files alongside `extension.wasm`,
the host serves them from the extension directory via a sandboxed file:// handler with
path traversal protection matching the existing `extension_mgr.rs` guards.

---

## Panel lifecycle

| Event | WIT call | Host action |
|:------|:---------|:------------|
| User or extension opens panel | `webview-host#open-panel` | Create Tauri WebviewWindow, call `get-html`, inject bridge, render |
| Webview JS posts message | Tauri IPC → host | Call `webview-provider#on-message`; dispatch response if Some |
| Extension pushes update | `webview-host#post-to-webview` | `evaluate_script` on webview window |
| User closes panel (X button) | Tauri close event → host | Call `webview-provider#on-close`; remove panel from registry |
| Extension closes panel | `webview-host#close-panel` | Destroy Tauri WebviewWindow |

---

## Security

- Webview HTML is rendered in a separate Tauri WebviewWindow with its own CSP.
- The bridge script only exposes `postMessage`; the webview JS cannot call arbitrary Tauri commands.
- The `webview_message` invoke handler validates `panel-id` against the registered panel registry;
  an unknown panel-id is rejected.
- Extension assets served from the extension directory are path-traversal-checked with the same
  guard already in `extension_mgr.rs`.
- Recommended CSP for extension webview windows:
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'`
  Note: the injected bridge script uses an inline `<script>` block, so `script-src` must include `'nonce-<random>'`
  or the bridge must be moved to an external file served as `'self'`. The `webview_message` invoke handler
  is the only Tauri command exposed to the webview; all other commands remain inaccessible.
  Extension assets served from the extension directory via the sidecar handler must still pass the
  existing path-traversal checks in `extension_mgr.rs`.

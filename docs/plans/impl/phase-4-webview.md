# Phase 4 — Webview Panels

**Goal:** A WASM extension can open a custom HTML panel, exchange messages with it,
and close it. The webview HTML/JS is identical across editors; only the bridge script differs.

**Depends on:** Phase 1 (WASM Host Foundation)

---

## 1. WIT additions

Add to `wit/corecode.wit`:

```wit
// Host import — what the WASM extension calls to manage panels
interface webview-host {
  open-panel:      func(panel-id: string, title: string, column: u8) -> result<_, string>;
  post-to-webview: func(panel-id: string, json: string) -> result<_, string>;
  close-panel:     func(panel-id: string);
}

// Extension export — what the host calls when something happens to a panel
interface webview-provider {
  get-html:   func(panel-id: string, state: option<string>) -> string;
  on-message: func(panel-id: string, json: string) -> option<string>;
  on-close:   func(panel-id: string);
}

// Update the world:
world corecode-extension {
  import ui;
  import workspace;
  import webview-host;       // new
  export lifecycle;
  export language-provider;
  export grammar-provider;
  export webview-provider;   // new (optional)
}
```

---

## 2. `corecode.toml` — capability gate

```toml
[capabilities]
webview_panels = true   # must be declared; host refuses to link webview-host otherwise
```

---

## 3. New module: `wasm_host/webview.rs`

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

const BRIDGE_SCRIPT: &str = include_str!("../assets/corecode-bridge.js");

/// Registry of open webview panels.
pub struct WebviewRegistry {
    /// panel-id → Tauri webview window label
    panels: Mutex<HashMap<String, String>>,
}

impl WebviewRegistry {
    pub fn new() -> Self {
        Self { panels: Mutex::new(HashMap::new()) }
    }

    /// Open a new webview panel.
    /// html: the raw HTML returned by the WASM extension's get-html export.
    pub fn open(
        &self,
        app: &AppHandle,
        panel_id: &str,
        title: &str,
        html: String,
    ) -> Result<(), String> {
        if self.panels.lock().unwrap().contains_key(panel_id) {
            return Err(format!("Panel '{}' already open", panel_id));
        }

        let label = format!("ext-panel-{}", sanitise_label(panel_id));
        let injected_html = inject_bridge(&html, panel_id);

        WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::Html(injected_html))
            .title(title)
            .inner_size(800.0, 600.0)
            .build()
            .map_err(|e| format!("Cannot create webview: {e}"))?;

        self.panels.lock().unwrap()
            .insert(panel_id.to_string(), label);

        Ok(())
    }

    /// Post a JSON message to the webview's JS context.
    pub fn post(&self, app: &AppHandle, panel_id: &str, json: &str) -> Result<(), String> {
        let label = self.panels.lock().unwrap()
            .get(panel_id).cloned()
            .ok_or_else(|| format!("Panel '{}' not open", panel_id))?;

        let window = app.get_webview_window(&label)
            .ok_or_else(|| format!("Window '{}' gone", label))?;

        let script = format!(
            "window.dispatchEvent(new MessageEvent('message', {{ data: {} }}));",
            json
        );
        window.eval(&script)
            .map_err(|e| format!("eval failed: {e}"))?;

        Ok(())
    }

    /// Close a panel.
    pub fn close(&self, app: &AppHandle, panel_id: &str) {
        let label = {
            let mut map = self.panels.lock().unwrap();
            map.remove(panel_id)
        };
        if let Some(label) = label {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.close();
            }
        }
    }

    /// Called when the OS close button is pressed — removes from registry.
    pub fn on_closed(&self, label: &str) {
        self.panels.lock().unwrap()
            .retain(|_, v| v != label);
    }
}

/// Inject the bridge script and the panel-id constant into the HTML.
fn inject_bridge(html: &str, panel_id: &str) -> String {
    let injection = format!(
        r#"<script>window.__CORECODE_PANEL_ID__ = {:?};</script>
<script>{}</script>"#,
        panel_id,
        BRIDGE_SCRIPT
    );

    // Insert just before </head> if present, otherwise prepend.
    if let Some(pos) = html.to_ascii_lowercase().find("</head>") {
        let mut result = html.to_string();
        result.insert_str(pos, &injection);
        result
    } else {
        format!("{}{}", injection, html)
    }
}

/// Produce a Tauri-safe window label from a panel-id.
/// Labels must be alphanumeric + hyphens.
fn sanitise_label(panel_id: &str) -> String {
    panel_id.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect()
}
```

---

## 4. Bridge script

Create `src/app/src-tauri/assets/corecode-bridge.js` (shipped inside the binary via `include_str!`):

```js
// corecode-bridge.js — CoreCode variant
// Injected by the host into every extension webview.
// Provides window.coreCode.postMessage as the sole IPC surface.

(function () {
  'use strict';

  window.coreCode = {
    /**
     * Send a message to the WASM extension.
     * data: any JSON-serialisable value
     */
    postMessage: function (data) {
      window.__TAURI__.invoke('webview_message', {
        panelId: window.__CORECODE_PANEL_ID__,
        json: JSON.stringify(data),
      });
    },
  };

  // Expose a convenience helper for request/response patterns.
  // Usage: const result = await window.coreCode.request({ type: 'getData' });
  window.coreCode.request = function (data) {
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
      window.coreCode.postMessage(wrapped);
    });
  };
})();
```

---

## 5. Tauri command: `webview_message`

Add to `lib.rs`:

```rust
#[tauri::command]
async fn webview_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    panel_id: String,
    json: String,
) -> Result<(), String> {
    // Validate panel_id — alphanumeric + hyphens + dots only
    if !panel_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '.') {
        return Err(format!("Invalid panel_id: '{panel_id}'"));
    }

    // Find which extension owns this panel
    let ext_id = state.wasm_host.panel_owner(&panel_id)
        .ok_or_else(|| format!("No extension owns panel '{panel_id}'"))?;

    // Call on-message on the WASM extension
    let response = state.wasm_host.webview_on_message(&ext_id, &panel_id, &json)?;

    // If the extension returned a response, dispatch it back to the webview
    if let Some(resp_json) = response {
        state.webview_registry.post(&app, &panel_id, &resp_json)?;
    }

    Ok(())
}
```

---

## 6. `webview-host` import implementations

In `api_impl.rs`, the three webview-host import functions need access to the Tauri `AppHandle`
and the `WebviewRegistry`. Pass them through `HostContext`:

```rust
pub struct HostContext {
    // ... existing fields ...
    pub app: Option<tauri::AppHandle>,
    pub webview_registry: Option<Arc<WebviewRegistry>>,
    pub panel_owner_ext_id: Option<String>,   // the owning extension's id
}
```

Host import implementations:

```rust
// webview_host::open_panel
pub fn host_open_panel(
    ctx: &mut HostContext,
    panel_id: String,
    title: String,
    _column: u8,
) -> Result<(), String> {
    if ctx.app.is_none() {
        return Err("no app handle in context".to_string());
    }
    // HTML will be fetched from the extension's get-html export by the caller
    // (manager.rs sets up the round-trip before calling open)
    let app = ctx.app.as_ref().unwrap();
    let registry = ctx.webview_registry.as_ref()
        .ok_or("no webview registry")?;

    // HTML is pushed in by manager.rs via an intermediate channel;
    // see manager.rs §7 for the full open-panel flow.
    let _ = (app, registry, panel_id, title);
    Ok(())
}
```

> **Design note:** Because `get-html` is a WASM export and `open-panel` is a WASM import
> that triggers `get-html` to be called, the call order is:
>
> 1. Extension calls `webview-host::open-panel(panel_id, title, column)`
> 2. Host's import handler receives this, calls back `webview-provider::get-html(panel_id, None)`
> 3. Host renders the returned HTML with the bridge injected
>
> This re-entrant call is possible because `wasmtime` supports it when called from within
> the same thread's Wasm execution, but it requires care with the `Store` borrow. The
> simplest implementation: the import handler stores `(panel_id, title)` in the `HostContext`
> and returns immediately; after the WASM export call returns, `manager.rs` processes any
> pending panel opens from the context.

---

## 7. Panel owner tracking in `WasmHostManager`

```rust
// In manager.rs:
panel_owners: Mutex<HashMap<String, String>>,  // panel-id → ext-id

pub fn register_panel_owner(&self, panel_id: &str, ext_id: &str) {
    self.panel_owners.lock().unwrap()
        .insert(panel_id.to_string(), ext_id.to_string());
}

pub fn panel_owner(&self, panel_id: &str) -> Option<String> {
    self.panel_owners.lock().unwrap().get(panel_id).cloned()
}

pub fn webview_on_message(
    &self,
    ext_id: &str,
    panel_id: &str,
    json: &str,
) -> Result<Option<String>, String> {
    let mut instances = self.instances.lock().unwrap();
    let inst = instances.get_mut(ext_id)
        .ok_or_else(|| format!("Extension '{}' not loaded", ext_id))?;
    inst.webview_on_message(panel_id, json)
}
```

---

## 8. `AppState` additions

```rust
webview_registry: Arc<wasm_host::webview::WebviewRegistry>,
```

Initialise in `run()`:

```rust
let webview_registry = Arc::new(wasm_host::webview::WebviewRegistry::new());
```

Register the panel-close Tauri event listener in `setup`:

```rust
// Listen for webview window close events to clean up registry
let registry_clone = Arc::clone(&webview_registry);
let wasm_host_clone = /* arc clone */;
app.on_window_event(move |window, event| {
    if let tauri::WindowEvent::CloseRequested { .. } = event {
        let label = window.label().to_string();
        if label.starts_with("ext-panel-") {
            registry_clone.on_closed(&label);
            // Find which extension owned this panel and call on-close
            // (look up in panel_owners by label, then call inst.webview_on_close)
        }
    }
});
```

---

## 9. Example extension

Create `examples/webview-counter/`:

```
examples/webview-counter/
  Cargo.toml
  corecode.toml
  src/
    lib.rs
  webview/
    panel.html
    panel.js
```

`src/lib.rs` (abbreviated):
```rust
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::OnceLock;

static COUNTER: OnceLock<AtomicI32> = OnceLock::new();

fn counter() -> &'static AtomicI32 {
    COUNTER.get_or_init(|| AtomicI32::new(0))
}

impl Guest for Extension {
    fn activate() -> Result<(), String> {
        webview_host::open_panel("counter-panel", "Counter", 1)?;
        Ok(())
    }
    fn deactivate() {}
}

impl WebviewProvider for Extension {
    fn get_html(_panel_id: &str, _state: Option<&str>) -> String {
        include_str!("../webview/panel.html").to_string()
    }

    fn on_message(_panel_id: &str, json: &str) -> Option<String> {
        #[derive(serde::Deserialize)] struct Msg { action: String }
        let msg: Msg = serde_json::from_str(json).ok()?;
        match msg.action.as_str() {
            "increment" => { counter().fetch_add(1, Ordering::Relaxed); }
            "decrement" => { counter().fetch_sub(1, Ordering::Relaxed); }
            _ => {}
        }
        let value = counter().load(Ordering::Relaxed);
        Some(format!(r#"{{"type":"count","value":{}}}"#, value))
    }

    fn on_close(_panel_id: &str) {}
}
```

`webview/panel.html`:
```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Counter</title></head>
<body>
  <h1 id="count">0</h1>
  <button id="inc">+</button>
  <button id="dec">−</button>
  <script src="panel.js"></script>
</body>
</html>
```

`webview/panel.js`:
```js
// window.coreCode is provided by the injected bridge — no import needed.
document.getElementById('inc').addEventListener('click', async () => {
  const resp = await window.coreCode.request({ action: 'increment' });
  document.getElementById('count').textContent = resp.value;
});

document.getElementById('dec').addEventListener('click', async () => {
  const resp = await window.coreCode.request({ action: 'decrement' });
  document.getElementById('count').textContent = resp.value;
});
```

---

## 10. Security checklist

- [ ] `panel_id` validated: alphanumeric + `-` + `.` only; max 64 chars
- [ ] Webview window CSP header set: `default-src 'none'; script-src 'self'; style-src 'self'`
- [ ] `webview_message` command validates `panel_id` before any store access
- [ ] `inject_bridge` does not trust extension HTML for script injection; only inserts before `</head>`
- [ ] Sidecar asset serving (if used) applies the existing path traversal guard from `extension_mgr.rs`
- [ ] Webview cannot call arbitrary Tauri commands — only `webview_message` is exposed

---

## 11. Acceptance criteria

- Launch CoreCode with `examples/webview-counter` installed
- The counter panel opens automatically on activation
- Clicking + increments the displayed number; clicking − decrements it
- The counter state is maintained in Rust across button clicks
- Closing the panel window calls `on-close` (verified via log output)
- No WASM extension can open a panel without `webview_panels = true` in `corecode.toml`

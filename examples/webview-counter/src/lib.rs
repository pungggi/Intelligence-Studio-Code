//! Webview Counter — demonstrates WASM webview panel support.
//!
//! Opens a panel on activation containing a counter with increment/decrement
//! buttons. Messages from the webview update internal state and the HTML is
//! re-rendered.
//!
//! Build:
//!   cargo build --target wasm32-wasip2 --release
//!   cp target/wasm32-wasip2/release/webview_counter.wasm webview-counter.wasm

wit_bindgen::generate!({
    world: "corecode-webview-extension",
    path: "../../src/app/src-tauri/wit/corecode.wit",
});

use corecode::extension::ui;
use corecode::extension::webview;
use exports::corecode::extension::lifecycle::Guest;

struct WebviewCounter;

// SAFETY: WASM components are single-threaded — no concurrent access to this global.
// A real extension should use a Cell or similar; `static mut` is used here for brevity.
static mut COUNTER: i32 = 0;

fn render_html(count: i32) -> String {
    format!(
        r#"<!DOCTYPE html>
<html>
<head>
<style>
  body {{ font-family: system-ui, sans-serif; text-align: center; padding: 2rem; background: #1e1e1e; color: #ccc; }}
  h1 {{ color: #569cd6; }}
  .count {{ font-size: 3rem; margin: 1rem 0; color: #dcdcaa; }}
  button {{ font-size: 1.2rem; padding: 0.5rem 1.5rem; margin: 0 0.5rem; cursor: pointer;
           background: #264f78; color: #fff; border: 1px solid #569cd6; border-radius: 4px; }}
  button:hover {{ background: #37699e; }}
</style>
</head>
<body>
  <h1>Webview Counter</h1>
  <div class="count">{count}</div>
  <button onclick="send('decrement')">-</button>
  <button onclick="send('increment')">+</button>
  <script>
    function send(action) {{
      // postMessage to the host (Tauri intercepts via iframe messaging)
      window.parent.postMessage(JSON.stringify({{ panel_id: 'counter', action }}), '*');
    }}
  </script>
</body>
</html>"#
    )
}

impl Guest for WebviewCounter {
    fn activate() -> Result<(), String> {
        ui::log("Counter", "Activating webview counter extension");
        webview::open_panel("counter", "Counter", 2)?;
        Ok(())
    }

    fn deactivate() {
        ui::log("Counter", "Deactivated");
    }
}

impl exports::corecode::extension::webview_provider::Guest for WebviewCounter {
    fn get_html(panel_id: String, _state: String) -> String {
        if panel_id == "counter" {
            let count = unsafe { COUNTER };
            render_html(count)
        } else {
            String::new()
        }
    }

    fn on_message(panel_id: String, message: String) {
        if panel_id != "counter" {
            return;
        }
        ui::log("Counter", &format!("Received message: {message}"));

        let count = unsafe { &mut COUNTER };
        if message.contains("increment") {
            *count += 1;
        } else if message.contains("decrement") {
            *count -= 1;
        }

        // Re-render the panel with updated state
        let html = render_html(*count);
        let _ = webview::set_html("counter", &html);
    }

    fn on_close(panel_id: String) {
        ui::log("Counter", &format!("Panel '{panel_id}' closed"));
    }
}

export!(WebviewCounter);

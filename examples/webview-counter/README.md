# Webview Counter

Minimal CoreCode WASM extension demonstrating the webview panel API.

Opens a panel on activation containing a counter with increment/decrement buttons.
Messages from the webview update internal state and the HTML is re-rendered.

## Build

```bash
cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/webview_counter.wasm webview-counter.wasm
```

Then copy the directory (with `corecode.toml` and the `.wasm` file) into CoreCode's extensions folder.

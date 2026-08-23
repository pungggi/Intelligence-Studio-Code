//! Hello WASM — minimal CoreCode extension demonstrating the Phase 1 lifecycle API.
//!
//! Build:
//!   cargo build --target wasm32-wasip2 --release
//!   cp target/wasm32-wasip2/release/hello_wasm.wasm .
//!
//! Then copy the whole directory into CoreCode's extensions folder.

wit_bindgen::generate!({
    world: "corecode-extension",
    path: "../../src/app/src-tauri/wit/corecode.wit",
});

use exports::corecode::extension::lifecycle::Guest;
use corecode::extension::ui;

struct HelloWasm;

impl Guest for HelloWasm {
    fn activate() -> Result<(), String> {
        ui::log("Hello WASM", "Extension activated successfully!");
        ui::show_message("info", "Hello from a Rust WASM extension!");
        Ok(())
    }

    fn deactivate() {
        ui::log("Hello WASM", "Extension deactivated.");
    }
}

export!(HelloWasm);

# 00 — Prerequisites

## Required Tools

| Tool | Minimum Version | Check Command |
|------|----------------|---------------|
| Rust (rustc + cargo) | 1.78+ | `rustc --version` |
| WASM target | wasm32-wasip2 | `rustup target list --installed` |
| Node.js | 18+ | `node --version` |
| Tauri CLI | 2.x | `cargo tauri --version` |

## One-Time Setup

```bash
# 1. Install the WASM target (if not already installed)
rustup target add wasm32-wasip2

# 2. Verify cargo-corecode compiles
cd tools/cargo-corecode
cargo build
# Expected: compiles without errors

# 3. Verify the Tauri app type-checks
cd src/app/src-tauri
cargo check
# Expected: compiles without errors (full build requires frontend setup)
```

## Environment Notes

- **Windows:** Use Git Bash or WSL for shell commands. Paths use forward slashes in this guide.
- **Extensions directory:** The app loads WASM extensions from a configurable directory.
  Check `src/app/src-tauri/src/wasm_host/manager.rs` for the current scan path.
- **Logs:** Set `RUST_LOG=debug` when running the app to see WASM host log output.

## Quick Smoke Test

If you just want to verify the build chain works end-to-end:

```bash
cd examples/hello-wasm
cargo build --target wasm32-wasip2
```

If this succeeds, your environment is ready. Proceed to [01-compile-extensions.md](01-compile-extensions.md).

# 03 — Runtime: Extension Lifecycle

**Phase:** 1
**Goal:** Verify the WASM host can discover, load, activate, and deactivate an extension at runtime.
**Time:** ~10 minutes
**Depends on:** [01-compile-extensions.md](01-compile-extensions.md) + working app build

---

## Setup

### Prepare the extension

```bash
cd <REPO>/examples/hello-wasm
cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/hello_wasm.wasm hello-wasm.wasm
```

Ensure the `examples/hello-wasm/` directory contains:
- `corecode.toml` (manifest)
- `hello-wasm.wasm` (binary)

### Start the app

```bash
cd <REPO>/src/app
RUST_LOG=debug cargo tauri dev
```

---

## T3.1 — Extension Discovery

The WASM host scans the extensions directory on startup.

- [ ] App starts without crash
- [ ] Log output contains a line indicating `hello-wasm` was discovered (look for extension ID `corecode.hello-wasm`)

---

## T3.2 — Activation

- [ ] Log shows "Extension activated successfully!" (from `ui::log`)
- [ ] Info message "Hello from a Rust WASM extension!" appears (from `ui::show_message`)
- [ ] No timeout error — activation completes within the epoch limit

---

## T3.3 — Deactivation

Trigger deactivation (close the app or use the extension management UI if available).

- [ ] Log shows "Extension deactivated." (from the `deactivate()` export)
- [ ] No crash on shutdown
- [ ] WASM instance is cleaned up (no lingering threads or memory leaks visible in logs)

---

## T3.4 — Duplicate Load Prevention

If the extension manager UI allows it, try to activate the same extension twice.

- [ ] Second activation is rejected or ignored (the `loading` set prevents double-loading)
- [ ] No panic or deadlock

---

## T3.5 — Missing WASM Binary

Rename the `.wasm` file temporarily:

```bash
cd <REPO>/examples/hello-wasm
mv hello-wasm.wasm hello-wasm.wasm.bak
```

Restart the app.

- [ ] Extension is **not** loaded
- [ ] A clear error is logged (not a panic)
- [ ] Other extensions (if any) still load normally

Restore:
```bash
mv hello-wasm.wasm.bak hello-wasm.wasm
```

---

## T3.6 — Corrupt WASM Binary

Create a broken binary:

```bash
echo "not a wasm file" > <REPO>/examples/hello-wasm/hello-wasm.wasm
```

Restart the app.

- [ ] Extension fails to load with a clear error message
- [ ] App continues running (no crash)

Restore:
```bash
cd <REPO>/examples/hello-wasm
cp target/wasm32-wasip2/release/hello_wasm.wasm hello-wasm.wasm
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Extension not found" | Wrong extensions directory | Check manager.rs scan path, verify `corecode.toml` exists |
| Timeout on activation | Epoch limit too low or WASM too slow in debug mode | Build with `--release`, or increase timeout in manager.rs |
| "Failed to instantiate" | wasmtime version mismatch | Ensure `wasmtime` and `wit-bindgen` versions are compatible |

## Next

Proceed to [04-language-provider.md](04-language-provider.md).

# 01 — Compile All Example Extensions

**Phase:** 1–4
**Goal:** Verify that all WIT bindings generate correctly and every example compiles to a valid WASM Component.
**Time:** ~5 minutes
**Depends on:** [00-prerequisites.md](00-prerequisites.md)

---

## T1.1 — hello-wasm (Phase 1: Lifecycle)

```bash
cd examples/hello-wasm
cargo build --target wasm32-wasip2 --release
```

- [ ] Compiles without errors
- [ ] `target/wasm32-wasip2/release/hello_wasm.wasm` exists
- [ ] File size is < 500 KB (optimized with `opt-level="z"`, LTO, strip)

---

## T1.2 — simple-lsp (Phase 2: Language Provider)

```bash
cd examples/simple-lsp
cargo build --target wasm32-wasip2 --release
```

- [ ] Compiles without errors
- [ ] `target/wasm32-wasip2/release/simple_lsp.wasm` exists
- [ ] Binary exports `language-provider` interface functions (verified later in [02-cargo-corecode-cli.md](02-cargo-corecode-cli.md))

---

## T1.3 — grammar-toml (Phase 3: Grammar Provider)

```bash
cd examples/grammar-toml
cargo build --target wasm32-wasip2 --release
```

- [ ] Compiles without errors
- [ ] `target/wasm32-wasip2/release/grammar_toml.wasm` exists

---

## T1.4 — webview-counter (Phase 4: Webview)

```bash
cd examples/webview-counter
cargo build --target wasm32-wasip2 --release
```

- [ ] Compiles without errors
- [ ] `target/wasm32-wasip2/release/webview_counter.wasm` exists

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `error[E0433]: failed to resolve` in generated bindings | WIT file not found | Check that `path` in `wit_bindgen::generate!` points to `../../src/app/src-tauri/wit/corecode.wit` |
| `error: target wasm32-wasip2 not found` | Missing target | `rustup target add wasm32-wasip2` |
| `wit-bindgen` version mismatch | Macro API changed | Pin `wit-bindgen = "0.26"` in `Cargo.toml` |
| Build succeeds but `.wasm` not found | Wrong profile directory | Check `target/wasm32-wasip2/debug/` if you omitted `--release` |

## Next

All 4 compile? Proceed to [02-cargo-corecode-cli.md](02-cargo-corecode-cli.md).

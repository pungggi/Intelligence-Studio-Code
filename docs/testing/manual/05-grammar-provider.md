# 05 — Runtime: Grammar Provider

**Phase:** 3
**Goal:** Verify that WASM grammar extensions provide highlight queries and bracket pairs to the editor.
**Time:** ~10 minutes
**Depends on:** [03-runtime-lifecycle.md](03-runtime-lifecycle.md) (app runs, extensions load)

---

## Setup

```bash
cd <REPO>/examples/grammar-toml
cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/grammar_toml.wasm grammar-toml.wasm
```

Ensure `examples/grammar-toml/` contains:
- `corecode.toml`
- `grammar-toml.wasm`
- `queries/highlights.scm`

Start the app with this extension loaded.

---

## T5.1 — Activation

- [ ] Log shows "Grammar provider activated for TOML files."
- [ ] No errors during load

---

## T5.2 — Highlights Query

1. Open a `.toml` file (e.g., any `Cargo.toml` in the repo)

- [ ] `highlights_query()` is called (visible in debug log)
- [ ] The returned query matches the content of `queries/highlights.scm`
- [ ] If the tree-sitter TOML grammar dylib is available: syntax highlighting is applied
  - [ ] Keys are highlighted differently from values
  - [ ] Strings have string coloring
  - [ ] Section headers `[section]` are highlighted

> **Note:** Actual highlighting requires both the WASM extension (provides the query) AND a native tree-sitter grammar dylib for TOML. If the dylib is not installed, the query is loaded but highlighting won't render. This is expected.

---

## T5.3 — Bracket Pairs

- [ ] `bracket_pairs()` returns valid JSON: `[["[","]"],["{","}"],["\"","\""]]`
- [ ] Editor recognizes TOML bracket pairs:
  - [ ] `[` and `]` are matched
  - [ ] `{` and `}` are matched (inline tables)
  - [ ] `"` pairs are matched (strings)

---

## T5.4 — Injections Query

- [ ] `injections_query()` returns `None` (TOML has no embedded languages)
- [ ] No error from a `None` return value

---

## T5.5 — Grammar Dylib Allowlist

The `corecode.toml` for grammar-toml may reference a `grammar-dylib` field.

- [ ] Only dylibs explicitly listed in the extension manifest are considered for loading
- [ ] A random `.dll`/`.so`/`.dylib` placed in the extension directory is **NOT** loaded
- [ ] Log shows the allowlist check (if `RUST_LOG=debug`)

> This is a security-critical check. Native grammar dylibs run outside the WASM sandbox.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Grammar provider activated" but no highlighting | Missing native tree-sitter dylib | The WASM part works — you need to compile `tree-sitter-toml` as a cdylib for your platform |
| `highlights_query()` returns empty string | `include_str!` path wrong | Check that `queries/highlights.scm` exists relative to `src/lib.rs` |
| Bracket matching doesn't work | JSON parsing issue | Verify `bracket_pairs()` returns valid JSON array of pairs |

## Next

Proceed to [06-webview-panels.md](06-webview-panels.md).

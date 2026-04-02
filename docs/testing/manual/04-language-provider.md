# 04 — Runtime: Language Provider API

**Phase:** 2
**Goal:** Verify that WASM extensions can provide completions, hover, and diagnostics through the language-provider interface.
**Time:** ~10 minutes
**Depends on:** [03-runtime-lifecycle.md](03-runtime-lifecycle.md) (app runs, extensions load)

---

## Setup

```bash
cd <REPO>/examples/simple-lsp
cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/simple_lsp.wasm simple-lsp.wasm
```

Ensure `examples/simple-lsp/` contains `corecode.toml` + `simple-lsp.wasm`, then start the app with this extension loaded.

---

## T4.1 — Activation & Status Bar

- [ ] Log shows "Language provider activated for plaintext."
- [ ] Status bar item "Simple LSP" appears (from `ui::set_status`)

---

## T4.2 — Completions

1. Open or create a plaintext file (`.txt`)
2. Start typing and trigger autocomplete (Ctrl+Space or natural trigger)

- [ ] Completion list shows **"hello"** with detail "Insert greeting"
- [ ] Completion list shows **"world"** with detail "Insert world"
- [ ] Selecting "hello" inserts the text "hello"
- [ ] "hello" item has documentation: "Inserts the word 'hello' — provided by simple-lsp WASM extension."

---

## T4.3 — Hover

1. In the same plaintext file, hover over any word

- [ ] Hover popup shows **"Plain text file"** (bold, rendered from markdown)
- [ ] Subtitle shows "Provided by `simple-lsp` WASM extension."

---

## T4.4 — Diagnostics

1. In the plaintext file, type a line containing `TODO`:
   ```
   This is a test line
   TODO fix this bug
   Another line with TODO here
   ```

- [ ] Lines with "TODO" get a **warning** underline/squiggle
- [ ] Diagnostic message reads: "TODO found — consider resolving this item."
- [ ] Diagnostic source shows "simple-lsp"
- [ ] Diagnostic code shows "todo-found"
- [ ] The highlight covers exactly the 4 characters "TODO" (correct range)

2. Remove "TODO" from a line

- [ ] Warning disappears after diagnostics refresh

---

## T4.5 — Other Language Provider Methods (Stub Behavior)

The simple-lsp returns empty results for these — verify they don't crash:

1. **Format Document** — trigger format on the plaintext file
   - [ ] No changes applied (empty edit list), no error

2. **Go to Definition** — trigger on any word
   - [ ] Nothing happens (returns `None`), no error

3. **Find References** — trigger on any word
   - [ ] Empty result, no error

---

## T4.6 — Language Scoping

simple-lsp claims only `plaintext`. Open a non-plaintext file (e.g., `.rs`, `.json`):

- [ ] "hello"/"world" completions do **NOT** appear
- [ ] No "TODO" diagnostics from simple-lsp

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No completions appear | Language not mapped to extension | Check `[languages]` in `corecode.toml` — needs `plaintext = true` |
| Completions appear but in wrong file types | Language scoping not applied | Check manager.rs language routing logic |
| Diagnostics show wrong character positions | Byte vs char offset | Verify `simple_lsp` uses `chars().count()` not byte index |

## Next

Proceed to [05-grammar-provider.md](05-grammar-provider.md).

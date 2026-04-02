# 02 — cargo-corecode CLI (Build Toolchain)

**Phase:** 5
**Goal:** Verify the cross-editor build toolchain: project scaffolding, compatibility checking, and package generation.
**Time:** ~15 minutes
**Depends on:** [01-compile-extensions.md](01-compile-extensions.md)

All commands use `cargo run` from `tools/cargo-corecode`. For convenience:

```bash
# Set this once per session (adjust to your repo path)
alias ccr="cargo run --manifest-path <REPO>/tools/cargo-corecode/Cargo.toml --"
```

---

## T2.1 — CLI Help Output

```bash
ccr corecode --help
ccr corecode new --help
ccr corecode build --help
ccr corecode check --help
```

- [ ] All 4 commands print help text without panic
- [ ] `new` shows `--template` option with default `language-provider`
- [ ] `build` shows `--target` and `--release` options
- [ ] `check` shows `--target` option with default `all`

---

## T2.2 — `cargo corecode new` — Project Scaffolding

Create a temporary directory for test output:

```bash
mkdir -p /tmp/corecode-test && cd /tmp/corecode-test
```

### T2.2a — language-provider template

```bash
ccr corecode new test-lang --template language-provider
```

- [ ] Directory `test-lang/` created
- [ ] `test-lang/Cargo.toml` exists with `crate-type = ["cdylib"]` and `wit-bindgen` dependency
- [ ] `test-lang/corecode.toml` exists with `[extension]`, `[entry]`, `[capabilities]` sections
- [ ] `test-lang/src/lib.rs` exists with `wit_bindgen::generate!` and `impl Guest`
- [ ] `test-lang/build.rs` exists

### T2.2b — format-provider template

```bash
ccr corecode new test-fmt --template format-provider
```

- [ ] Same structure as above
- [ ] `src/lib.rs` contains format-related trait implementation

### T2.2c — grammar template

```bash
ccr corecode new test-gram --template grammar
```

- [ ] Same structure as above
- [ ] `src/lib.rs` uses `corecode-grammar-extension` world
- [ ] `corecode.toml` references grammar capabilities

### T2.2d — webview template

```bash
ccr corecode new test-web --template webview
```

- [ ] Same structure as above
- [ ] `src/lib.rs` uses `corecode-webview-extension` world
- [ ] `corecode.toml` has `webview_panels = true`
- [ ] `src/lib.rs` contains HTML rendering code

### T2.2e — Invalid template

```bash
ccr corecode new test-bad --template nonexistent
```

- [ ] Prints a clear error message (not a panic/stack trace)

---

## T2.3 — `cargo corecode check` — WIT Compatibility

Requires compiled WASM binaries from [01-compile-extensions.md](01-compile-extensions.md).

### T2.3a — hello-wasm (no special interfaces)

```bash
cd <REPO>/examples/hello-wasm
ccr corecode check --target all
```

Expected output:
```
  corecode: ok
  zed: ok
  vscode: ok
```

- [ ] All three targets show `ok`
- [ ] No warnings (hello-wasm has no special interfaces)

### T2.3b — webview-counter (webview interface)

```bash
cd <REPO>/examples/webview-counter
ccr corecode check --target all
```

Expected output:
```
  corecode: ok
  zed: ok
    warning: webview-provider not supported in Zed (will be excluded)
  vscode: ok
```

- [ ] Zed target shows webview warning
- [ ] CoreCode and VS Code show `ok`

### T2.3c — Invalid target

```bash
cd <REPO>/examples/hello-wasm
ccr corecode check --target foobar
```

- [ ] Prints error about unknown target

---

## T2.4 — `cargo corecode build` — Package Generation

### T2.4a — Build all targets for hello-wasm

```bash
cd <REPO>/examples/hello-wasm
ccr corecode build --target all --release
```

- [ ] Command completes without error
- [ ] `dist/` directory created

### T2.4b — Validate .ccext (CoreCode native)

- [ ] `dist/corecode.hello-wasm.ccext` exists
- [ ] It is a valid ZIP file (open with any ZIP tool)
- [ ] Contains `corecode.toml`
- [ ] Contains the `.wasm` binary

### T2.4c — Validate .zip (Zed)

- [ ] `dist/corecode.hello-wasm.zip` exists
- [ ] Contains `extension.toml`
- [ ] Contains the `.wasm` binary

### T2.4d — Validate .vsix (VS Code)

- [ ] `dist/corecode.hello-wasm.vsix` exists
- [ ] It is a valid ZIP file
- [ ] Contains `extension/package.json` — open it and verify:
  - [ ] `name` matches extension ID
  - [ ] `engines.vscode` is set
  - [ ] `main` points to `./dist/extension.js`
- [ ] Contains `extension/dist/extension.js` (generated Node.js adapter)
- [ ] Contains `extension/dist/extension.wasm`

### T2.4e — Build single target

```bash
cd <REPO>/examples/simple-lsp
ccr corecode build --target corecode --release
```

- [ ] Only `.ccext` file created (no `.zip`, no `.vsix`)

---

## Cleanup

```bash
rm -rf /tmp/corecode-test
# Remove dist/ folders from examples
rm -rf <REPO>/examples/hello-wasm/dist
rm -rf <REPO>/examples/simple-lsp/dist
```

## Next

Proceed to [03-runtime-lifecycle.md](03-runtime-lifecycle.md) for runtime tests.

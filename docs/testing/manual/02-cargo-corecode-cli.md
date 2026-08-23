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
ccr corecode publish --help
```

- [ ] All 5 commands print help text without panic
- [ ] `new` shows `--template` option with default `language-provider`
- [ ] `build` shows `--target` and `--release` options
- [ ] `check` shows `--target` option with default `all`
- [ ] `publish` shows `--token`, `--registry`, and `--dry-run` options

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
- [ ] `corecode.hello-wasm-0.1.0.ccext`, `corecode.hello-wasm-0.1.0-zed.zip`, and `corecode.hello-wasm-0.1.0.vsix` are created in the extension directory

### T2.4b — Validate .ccext (CoreCode native)

- [ ] `corecode.hello-wasm-0.1.0.ccext` exists
- [ ] It is a valid ZIP file (open with any ZIP tool)
- [ ] Contains `corecode.toml`
- [ ] Contains `extension.wasm`

### T2.4c — Validate .zip (Zed)

- [ ] `corecode.hello-wasm-0.1.0-zed.zip` exists
- [ ] Contains `extension.toml`
- [ ] Contains the `.wasm` binary

### T2.4d — Validate .vsix (VS Code)

- [ ] `corecode.hello-wasm-0.1.0.vsix` exists
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

## T2.5 — `cargo corecode publish` — Marketplace Upload

Requires a compiled extension (T2.4a). The marketplace server is Phase 6 —
until it exists, only the dry-run and error paths are testable.

### T2.5a — Dry run

```bash
cd <REPO>/examples/hello-wasm
ccr corecode publish --dry-run
```

- [ ] Builds a release `.ccext` first
- [ ] Prints extension id, version, package name and size
- [ ] Prints `dry run: package built and validated, upload skipped`
- [ ] Exits 0

### T2.5b — Missing token

```bash
unset CORECODE_TOKEN
ccr corecode publish
```

- [ ] Builds the package, then fails with `no API token — pass --token or set CORECODE_TOKEN`
- [ ] Exits non-zero

### T2.5c — Unreachable registry

```bash
ccr corecode publish --token fake --registry http://127.0.0.1:1
```

- [ ] Fails with a `could not reach registry` transport error and suggests `--dry-run`
- [ ] Exits non-zero

### T2.5d — Invalid manifest

```bash
mkdir -p /tmp/corecode-test/pub-bad && cd /tmp/corecode-test/pub-bad
echo '[extension]
id = "nodash"
name = "x"
version = "0.1"
' > corecode.toml
ccr corecode publish --dry-run
```

- [ ] Fails with `extension id must be 'publisher.name'` or the semver message
- [ ] Exits non-zero

### T2.5e — Live publish (Phase 6, blocked)

- [ ] Blocked until the marketplace endpoint exists: `POST {registry}/api/v1/publish`
  with `Authorization: Bearer`, `X-CoreCode-Extension`, `X-CoreCode-Version` headers
  and the `.ccext` bytes as body. 200/201 = success, 409 = version already published.

---

## Cleanup

```bash
rm -rf /tmp/corecode-test
# Remove generated packages from examples
rm -f <REPO>/examples/hello-wasm/*.ccext <REPO>/examples/hello-wasm/*.zip <REPO>/examples/hello-wasm/*.vsix
rm -f <REPO>/examples/simple-lsp/*.ccext
```

## Next

Proceed to [03-runtime-lifecycle.md](03-runtime-lifecycle.md) for runtime tests.

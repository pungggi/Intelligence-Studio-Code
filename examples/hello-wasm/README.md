# hello-wasm

Minimal CoreCode WASM extension — Phase 1 example.

## Prerequisites

```sh
rustup target add wasm32-wasip2
```

## Build

```sh
cargo build --target wasm32-wasip2 --release

# Unix/macOS:
cp target/wasm32-wasip2/release/hello_wasm.wasm hello-wasm.wasm

# Windows (PowerShell):
# Copy-Item target\wasm32-wasip2\release\hello_wasm.wasm hello-wasm.wasm
```

> **Note:** Rust converts package-name hyphens to underscores in the produced artifact (so `target/wasm32-wasip2/release/hello_wasm.wasm` is the actual build output). We copy/rename it to `hello-wasm.wasm` for the example.

## Install

To install the extension, copy the minimum required file set into the CoreCode extensions folder.

**Minimum required file set:**
- `hello-wasm.wasm` (the compiled WASM module)
- `corecode.toml` (or an equivalent manifest like `package.json` or `manifest.json`)

Additional source files (e.g., `src/`, `Cargo.toml`, `build.rs`, and `README.md`) are optional and do not need to be copied into the final extension directory.

For example, your installed extension folder should look like this:
- `hello-wasm.wasm`
- `corecode.toml`

Use the following paths as placement guidance based on your platform:

| Platform | Path |
|:---------|:-----|
| Windows  | `%LOCALAPPDATA%\corecode\extensions\corecode.hello-wasm\` |
| macOS    | `~/Library/Application Support/corecode/extensions/corecode.hello-wasm/` |
| Linux    | `~/.local/share/corecode/extensions/corecode.hello-wasm/` |

## Expected behaviour

On launch, the CoreCode output panel shows:

```
Hello WASM — Extension activated successfully!
```

An info notification reads:

```
Hello from a Rust WASM extension!
```

On close:

```
Hello WASM — Extension deactivated.
```

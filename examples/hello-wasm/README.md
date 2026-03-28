# hello-wasm

Minimal CoreCode WASM extension — Phase 1 example.

## Prerequisites

```sh
rustup target add wasm32-wasip2
```

## Build

```sh
cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/hello_wasm.wasm hello-wasm.wasm
```

## Install

Copy this directory into the CoreCode extensions folder:

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

# Manual Test Plan — WASM Extension Host

Structured manual tests for all 5 phases of the WASM extension host implementation.

## Prerequisites

See [00-prerequisites.md](00-prerequisites.md) before running any tests.

## Test Suites

| File | Phase | What it covers | Effort |
|------|-------|----------------|--------|
| [01-compile-extensions.md](01-compile-extensions.md) | 1–4 | Compile all 4 example extensions to WASM | 5 min |
| [02-cargo-corecode-cli.md](02-cargo-corecode-cli.md) | 5 | CLI help, `new`, `check`, `build` commands | 15 min |
| [03-runtime-lifecycle.md](03-runtime-lifecycle.md) | 1 | Load hello-wasm, activate/deactivate cycle | 10 min |
| [04-language-provider.md](04-language-provider.md) | 2 | Completions, hover, diagnostics via simple-lsp | 10 min |
| [05-grammar-provider.md](05-grammar-provider.md) | 3 | Tree-sitter grammar loading, highlights, brackets | 10 min |
| [06-webview-panels.md](06-webview-panels.md) | 4 | Webview counter panel, message passing | 10 min |
| [07-security.md](07-security.md) | 1–4 | Path traversal, WASM timeout, iframe sandbox | 15 min |

## Recommended Order

1. **00-prerequisites** — install tools, verify environment
2. **01-compile-extensions** — if these fail, nothing else will work
3. **02-cargo-corecode-cli** — test the build toolchain independently
4. **03-runtime-lifecycle** — first real app launch, simplest extension
5. **04 through 06** — feature tests (can run in any order after 03)
6. **07-security** — adversarial tests last

## Conventions

- `[x]` = checkpoint you must verify manually
- Commands assume you are in the repository root unless stated otherwise
- `<REPO>` = absolute path to the repository root

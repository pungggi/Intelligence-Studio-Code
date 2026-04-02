# CoreCode

A hybrid, high-performance code editor combining native rendering speed with the VS Code extension ecosystem.

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Native Frontend │◄───►│  IPC Bridge  │◄───►│  Extension Host   │
│  (Rust/Tauri)    │     │ (FlatBuffers)│     │  (Node.js)        │
│                  │     │              │     │                   │
│  - wgpu Renderer │     │  - Unix      │     │  - VS Code APIs   │
│  - Tree-sitter   │     │    Sockets   │     │  - LSP Servers    │
│  - Rope Buffer   │     │  - Batching  │     │  - Extensions     │
└─────────────────┘     └──────────────┘     └──────────────────┘
```

## Project Structure

```
src/
├── frontend/          # Rust/Tauri native frontend
│   ├── Cargo.toml
│   └── src/
├── extension-host/    # Node.js Extension Host
│   ├── package.json
│   └── src/
├── ipc/               # IPC bridge definitions & protocols
│   ├── schemas/       # FlatBuffers schemas
│   └── src/
tests/                 # Integration tests
scripts/               # Build & dev scripts
docs/                  # Documentation & PRD
```

## Getting Started

> **Status:** Initial scaffold — Milestone M0 (Technology Spike)

### Prerequisites

- Rust (stable, >= 1.75)
- Node.js (>= 20 LTS)
- Tauri CLI v2

### Development

```bash
# Frontend (Rust/Tauri)
cd src/frontend && cargo build

# Extension Host
cd src/extension-host && npm install

# Run both (dev mode)
npm run dev
```

## Documentation

- [PRD (Product Requirements)](docs/prd-corecode.md)
- [PRD Review](docs/prd-review.md)

## Vendored Dependencies

Some frontend dependencies (like `xterm.js`) are vendored for simplicity in the build-less Tauri frontend. To update or regenerate these assets, use the provided scripts:

```bash
# On Windows (PowerShell)
./scripts/regenerate-xterm.ps1

# On Linux/macOS (Bash)
./scripts/regenerate-xterm.sh
```

See `src/app/src/lib/xterm/VERSION` for currently tracked versions and checksums.

## License

TBD (see PRD Section 8)

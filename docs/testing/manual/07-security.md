# 07 — Security Tests

**Phase:** 1–4
**Goal:** Verify sandbox boundaries, path restrictions, and timeout enforcement.
**Time:** ~15 minutes
**Depends on:** [03-runtime-lifecycle.md](03-runtime-lifecycle.md) (app runs, extensions load)

> These tests validate defenses against malicious or buggy extensions. Some require modifying extension source code or using browser DevTools.

---

## T7.1 — Path Traversal: Workspace Edit Restriction

Extensions can request file edits through `apply_workspace_edit`. Edits must be confined to the workspace root.

### Via IPC / DevTools

If you can send raw IPC commands (Tauri DevTools console):

```javascript
// Attempt to edit a file outside the workspace
window.__TAURI__.invoke('apply_workspace_edit', {
  edits: [{ uri: 'file:///etc/passwd', newText: 'malicious' }]
})
```

- [ ] Returns error: "Access denied: ... is outside the workspace root"
- [ ] File is NOT modified

### Via Windows path

```javascript
window.__TAURI__.invoke('apply_workspace_edit', {
  edits: [{ uri: 'file:///C:/Windows/System32/config/sam', newText: 'x' }]
})
```

- [ ] Returns error with "Access denied" or "outside the workspace root"

### Path with `..` traversal

```javascript
window.__TAURI__.invoke('apply_workspace_edit', {
  edits: [{ uri: 'file:///workspace/../../../etc/shadow', newText: 'x' }]
})
```

- [ ] Path is canonicalized before check — `..` does not bypass restriction
- [ ] Returns "Access denied"

---

## T7.2 — Path Traversal: Home Directory Confinement (Layer 1)

The `validate_path()` function restricts all file access to `$HOME`.

- [ ] Attempting to read `/etc/hosts` (or `C:\Windows\System32\hosts`) via a WASM `workspace::read_file` call fails
- [ ] Error message indicates path is outside allowed area
- [ ] No partial read or information leak

---

## T7.3 — Open Buffer Edit Without Workspace Root

When no workspace folder is open but a single file is being edited:

1. Open the app without a workspace (single file mode)
2. Open a file in the editor buffer
3. An extension attempts `apply_workspace_edit` on that file

- [ ] Edit is **allowed** (file is in an open buffer, Layer 1 home-dir check still applies)
- [ ] Edit on a file NOT in any buffer is **rejected** with "no workspace root is registered and the file is not open in the editor"

---

## T7.4 — WASM Timeout (Epoch Interruption)

Build a malicious test extension with an infinite loop:

```rust
impl Guest for EvilExt {
    fn activate() -> Result<(), String> {
        loop {} // never returns
    }
    fn deactivate() {}
}
```

1. Compile to WASM and load it

- [ ] Extension activation times out (does not hang the app)
- [ ] Error is logged with a timeout/epoch message
- [ ] App remains responsive — other extensions still work
- [ ] The extension is marked as failed (not retried endlessly)

---

## T7.5 — WASM Memory Limit

Build a test extension that allocates excessive memory:

```rust
fn activate() -> Result<(), String> {
    let mut v = Vec::new();
    loop { v.push(vec![0u8; 1_000_000]); } // allocate until OOM
}
```

- [ ] WASM instance is terminated when memory limit is exceeded
- [ ] Host process (Tauri app) is NOT affected
- [ ] Error is logged

---

## T7.6 — Webview Iframe Sandbox

The webview panel uses an iframe with sandbox attributes `allow-scripts allow-forms` (no `allow-same-origin`).

1. Load the webview-counter extension
2. Open browser DevTools on the webview panel
3. In the DevTools console, try:

```javascript
// Attempt cookie access
document.cookie
// Expected: empty string or SecurityError

// Attempt fetch to external URL
fetch('https://example.com').then(r => r.text()).then(console.log)
// Expected: blocked by sandbox / CORS

// Attempt to access parent frame
window.parent.document
// Expected: SecurityError (cross-origin)

// Attempt localStorage
localStorage.setItem('test', 'value')
// Expected: SecurityError
```

- [ ] `document.cookie` returns empty or throws
- [ ] `fetch()` to external URLs is blocked
- [ ] `window.parent.document` throws SecurityError
- [ ] `localStorage` access is blocked
- [ ] `postMessage` to parent still works (this is the intended communication channel)

---

## T7.7 — Native Grammar Dylib Allowlist

1. Place a random `.dll`/`.so`/`.dylib` file in an extension directory (not listed in `corecode.toml`)
2. Load the extension

- [ ] The unlisted dylib is **NOT** loaded
- [ ] Only dylibs explicitly referenced via `grammar-dylib` in `corecode.toml` are considered
- [ ] Log shows the allowlist check rejecting unexpected files

---

## T7.8 — Capability Gating

hello-wasm declares `workspace_read = false` in its `corecode.toml`.

If the extension tries to call `workspace::read_file`:

- [ ] Call is rejected at the capability check layer
- [ ] Error message references missing capability
- [ ] File is NOT read

---

## Summary Checklist

| Test | Security Property | Pass? |
|------|------------------|-------|
| T7.1 | Workspace root confinement | [ ] |
| T7.2 | Home directory confinement | [ ] |
| T7.3 | Open buffer edit (no workspace) | [ ] |
| T7.4 | Epoch-based timeout | [ ] |
| T7.5 | Memory limit enforcement | [ ] |
| T7.6 | Webview iframe sandbox | [ ] |
| T7.7 | Grammar dylib allowlist | [ ] |
| T7.8 | Capability gating | [ ] |

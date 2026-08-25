# 06 — Runtime: Webview Panels

**Phase:** 4
**Goal:** Verify that WASM extensions can open webview panels, render HTML, and exchange messages with the host.
**Time:** ~10 minutes
**Depends on:** [03-runtime-lifecycle.md](03-runtime-lifecycle.md) (app runs, extensions load)

---

## Setup

```bash
cd <REPO>/examples/webview-counter
cargo build --target wasm32-wasip2 --release
cp target/wasm32-wasip2/release/webview_counter.wasm webview-counter.wasm
```

Ensure `examples/webview-counter/` contains `corecode.toml` + `webview-counter.wasm`, then start the app.

---

## T6.1 — Panel Opens on Activation

- [ ] Log shows "Activating webview counter extension"
- [ ] A panel titled **"Counter"** opens automatically
- [ ] Panel renders HTML with dark background (`#1e1e1e`)
- [ ] Counter displays **0**
- [ ] Two buttons visible: **-** and **+**

---

## T6.2 — Increment

Click the **+** button multiple times.

- [ ] Counter increments: 0 → 1 → 2 → 3
- [ ] Log shows `Received message: ...increment...` for each click
- [ ] HTML re-renders after each click (panel updates visually)

---

## T6.3 — Decrement

Click the **-** button.

- [ ] Counter decrements: 3 → 2 → 1 → 0 → -1
- [ ] Negative numbers display correctly
- [ ] Log shows `Received message: ...decrement...` for each click

---

## T6.4 — Message Passing Flow

This verifies the full round-trip:

1. Button click in webview → `postMessage` to parent iframe
2. Host receives message → calls WASM `on_message` export
3. WASM updates state → calls `webview::set_html` import
4. Host updates the panel HTML

- [ ] Each button click triggers exactly one log entry (no double-firing)
- [ ] There is no noticeable delay between click and counter update
- [ ] The panel ID in logs is consistently `"counter"`

---

## T6.5 — Panel Close

Close the webview panel (via tab close or UI control).

- [ ] Log shows "Panel 'counter' closed" (from `on_close` export)
- [ ] No crash or error on close
- [ ] Extension remains active (can potentially reopen the panel)

---

## T6.6 — get_html with Unknown Panel ID

If the extension receives a `get_html` call with an unknown panel ID:

- [ ] Returns an empty string (not a crash)
- [ ] No side effects

---

## T6.7 — Rapid Clicking

Click **+** rapidly (10+ times in quick succession).

- [ ] All clicks are processed (counter reaches expected value)
- [ ] No message loss or duplicate counting
- [ ] UI remains responsive

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Panel opens but is blank | HTML not set after `open_panel` | Check that `get_html` is called after panel creation |
| Clicks don't update counter | `postMessage` not reaching host | Check iframe sandbox flags — `allow-scripts` must be present |
| Counter updates but panel doesn't re-render | `set_html` not wired to panel update | Check `api_impl.rs` webview set_html handling |
| "Panel 'counter' closed" appears on activation | Panel ID collision with a previous session | Verify panel IDs are unique per extension instance |

## Next

Proceed to [07-security.md](07-security.md).

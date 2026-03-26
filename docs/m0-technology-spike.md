# M0: Technology Spike — Evaluationsplan

**Dauer:** 2 Wochen
**Ziel:** Validierung der Kernarchitektur-Entscheidungen durch minimale Prototypen.

---

## Spike 1: wgpu Text-Rendering (3 Tage)

### Ziel
Beweisen, dass wgpu performantes Text-Rendering mit < 16ms Frame-Zeit liefert.

### Aufgaben
1. Minimales Fenster mit `winit` + `wgpu` erstellen
2. Monospaced-Font laden (z.B. JetBrains Mono) via `fontdue` oder `cosmic-text`
3. Glyph-Atlas auf GPU erstellen
4. 1.000 Zeilen Text rendern und Frame-Zeit messen
5. Scrolling implementieren und Latenz messen

### Erfolgskriterien
- [ ] Fenster öffnet in < 200ms
- [ ] 1.000 Zeilen Text rendern bei < 16ms Frame-Zeit
- [ ] Scrolling bei < 8ms Latenz (Input → Frame)

### Fallback
Falls wgpu zu Low-Level: `cosmic-text` als höhere Abstraktionsschicht evaluieren.

---

## Spike 2: IPC Latenz-Benchmark (2 Tage)

### Ziel
Messen der Round-Trip-Latenz zwischen Rust und Node.js über Unix Domain Sockets.

### Aufgaben
1. Minimaler Rust-Client: Sendet FlatBuffers-Nachrichten über Unix Socket
2. Minimaler Node.js-Server: Empfängt, deserialisiert, antwortet
3. Benchmark: 10.000 Nachrichten senden und RTT messen
4. Vergleich: FlatBuffers vs. JSON-RPC Serialisierung

### Erfolgskriterien
- [ ] Einzelnachricht RTT < 1ms (FlatBuffers)
- [ ] Durchsatz > 50.000 Nachrichten/Sekunde
- [ ] FlatBuffers mindestens 3x schneller als JSON-RPC

### Fallback
Falls Unix Sockets nicht schnell genug: Shared Memory (mmap) evaluieren.

---

## Spike 3: Extension Host Machbarkeit (3 Tage)

### Ziel
Beweisen, dass eine VS Code Extension in einem isolierten Node.js-Prozess laden und aktiviert werden kann.

### Aufgaben
1. Minimalen `vscode`-API-Shim erstellen (nur `commands.registerCommand`)
2. Eine triviale Extension erstellen (registriert einen Command, gibt "Hello" zurück)
3. Extension via `require()` laden und `activate()` aufrufen
4. Command über IPC vom Rust-Client auslösen

### Erfolgskriterien
- [ ] Extension lädt ohne Fehler
- [ ] `activate()` wird aufgerufen
- [ ] Command ist über IPC aufrufbar
- [ ] Round-Trip (Rust → Node.js → Extension → Node.js → Rust) < 5ms

---

## Spike 4: Tree-sitter Integration (2 Tage)

### Ziel
Tree-sitter in den Rust-Textbuffer integrieren und inkrementelles Parsing validieren.

### Aufgaben
1. `tree-sitter` + `tree-sitter-javascript` in Rust integrieren
2. 10.000-Zeilen JavaScript-Datei parsen
3. Einzelne Zeile editieren und inkrementelles Re-Parsing messen
4. Syntax-Nodes in Farbmarkierungen übersetzen

### Erfolgskriterien
- [ ] Initiales Parsing von 10.000 Zeilen < 50ms
- [ ] Inkrementelles Re-Parsing < 1ms
- [ ] Korrekte Syntax-Nodes für Basis-Token (keywords, strings, comments)

---

## Entscheidungsmatrix nach Spike-Phase

| Kriterium | wgpu + Custom | Tauri v2 (WebView) | Entscheidung |
|:---|:---|:---|:---|
| Frame-Zeit | Spike 1 Ergebnis | Baseline ~16ms | TBD |
| Startup-Zeit | Spike 1 Ergebnis | ~300-500ms | TBD |
| RAM-Verbrauch | Erwartet < 50MB | ~100-150MB | TBD |
| Entwicklungsaufwand | Hoch (Custom UI) | Mittel (HTML/CSS) | TBD |
| Plattform-Support | wgpu = alle | Tauri = alle | Gleich |
| Accessibility | Manuell | Browser-nativ | Tauri+ |

### Entscheidungspunkt
Nach Abschluss aller Spikes wird in einem Architektur-Review entschieden:
- **Option A:** Volles Custom-Rendering mit wgpu (maximale Performance)
- **Option B:** Tauri v2 mit optimiertem Frontend (schnellere Entwicklung, bessere Accessibility)
- **Option C:** Hybrid — Tauri-Shell mit wgpu-Canvas für den Text-Editor (Kompromiss)

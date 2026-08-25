# Product Requirements Document (PRD)

**Projektname:** CoreCode (Arbeitstititel)
**Dokumentenstatus:** Überarbeitete Definition / Architektur-Konzept mit AI-Strategie
**Letztes Update:** 25. Mai 2026
**Version:** 2.0 (inkl. AI-Native Strategy + pi.dev Integration)

---

## 1. Executive Summary & Vision

**Vision:** Entwicklung eines hybriden, extrem performanten **AI-native Code-Editors**, der die Geschwindigkeit und Ressourceneffizienz einer nativen Applikation mit dem weitreichenden Ökosystem der Visual Studio Code-Erweiterungen vereint — und gleichzeitig eine tief integrierte, kontextbewusste KI-Erfahrung bietet.

**Das Problem:** Traditionelle Electron-basierte Editoren (wie VS Code) leiden unter hohem RAM-Bedarf und langsamen Startzeiten aufgrund der gebündelten Chromium- und Node.js-Prozesse für das UI. Native Editoren (wie Zed) sind performant, haben aber kein vergleichbares Extension-Ökosystem. AI-first Editoren (Cursor, Windsurf) sind oft proprietär und schwer erweiterbar.

**Die Lösung:** Eine strikte Entkopplung ("Frankenstein"-Architektur). Das Rendering und die UI-Logik erfolgen in einer nativen, speichersicheren Umgebung (Rust/GPU-beschleunigt). Die VS Code-Erweiterungen laufen in einem isolierten, unsichtbaren Node.js-Hintergrundprozess (dem Extension Host). Zusätzlich wird eine **AI Context Engine** + **pi.dev** als primäres Agenten-Framework integriert, um kontextreiche, agenten-basierte Workflows nativ zu ermöglichen. Die massive Fleißarbeit der API-Anbindung wird durch eine gestufte KI-Agenten-Pipeline mit manueller Qualitätssicherung gelöst.

**Neu in v2.0:** CoreCode wird zu einer **AI-native Plattform** — KI ist kein Add-on, sondern ein erster Bürger der Architektur.

---

## 2. Systemarchitektur

Das System besteht aus fünf isolierten Kernkomponenten:

### 2.1. Natives Frontend (Der "Körper")

* **Technologie:** Tauri v2 für Fenster-Management und Plattform-Integration, kombiniert mit wgpu für GPU-beschleunigtes Text-Rendering.
  * *Begründung:* Tauri bietet ausgereiftes Plattform-Handling (Menüs, Dialoge, Tray, Auto-Update) ohne Chromium-Overhead. wgpu ermöglicht hardwarebeschleunigtes, plattformübergreifendes Rendering mit direkter Kontrolle über die Render-Pipeline.
* **Zuständigkeiten:**
  * Text-Rendering und UI-Darstellung in nativer Geschwindigkeit (Ziel: < 16ms Frame-Zeit).
  * Input-Handling (Tastatur, Maus).
  * Direktes, schnelles File-System I/O für das Laden des Workspaces.
  * Plattform-native Schrift-APIs (DirectWrite/Windows, CoreText/macOS, FreeType/Linux).
  * Beinhaltet **keine** JavaScript-Engine oder Node.js-Laufzeitumgebung.

### 2.2. Text-Editing Engine (Das "Herz")

* **Text-Buffer:** Rope-Datenstruktur (basierend auf `ropey` oder eigener Implementation).
  * *Begründung:* O(log n) für Einfüge-/Löschoperationen, effiziente Zeilenindexierung, bewährt bei Zed und Lapce.
* **Syntax Highlighting:** Tree-sitter für inkrementelles Parsing.
  * *Begründung:* Fehlertolerant, inkrementell (nur geänderte Bereiche werden neu geparst), sprach-agnostisch durch Grammar-Dateien.
* **Undo/Redo:** Operation-basierter Undo-Stack mit Branch-Historie (nicht-lineares Undo).
* **Multi-Cursor:** Nativ unterstützt auf Buffer-Ebene (Selektionen als sortierte Range-Liste).
* **Encoding:**
  * Intern: UTF-8 (Rope-Standard).
  * LSP-Kompatibilität: UTF-16-Offset-Konvertierung an der IPC-Grenze (LSP spezifiziert UTF-16-Positionen).

### 2.3. Node.js Extension Host (Das "Gehirn")

* **Technologie:** Node.js (headless).
* **Zuständigkeiten:**
  * Startet einen modifizierten Fork des originalen VS Code `extHost` (oder einen API-kompatiblen Nachbau).
  * Lädt, aktiviert und verwaltet unmodifizierte VS Code-Erweiterungen (z.B. ESLint, Prettier, Python-Tools).
  * Führt die JavaScript/TypeScript-Logik der Extensions aus.
  * Verwaltet LSP-Server als Kindprozesse (siehe 2.5).

### 2.4. Die Inter-Process Communication (IPC) Brücke

* **Technologie:** Bidirektionales RPC über Unix Domain Sockets (Linux/macOS) bzw. Named Pipes (Windows), mit FlatBuffers als Serialisierungsformat.
  * *Begründung:* FlatBuffers ermöglicht Zero-Copy-Deserialisierung, deutlich schneller als JSON-RPC bei hochfrequenten Text-Updates.
* **Zuständigkeiten:**
  * Nahtlose, asynchrone Synchronisation des Dokumentenstatus zwischen Frontend und Backend.
  * Weiterleitung von UI-Events (z.B. Hover, Klick) an den Host.
  * Empfang von Extension-Kommandos (z.B. `zeige Fehlermarkierung`, `öffne Notification`) an das Frontend.
* **Batching:** Textänderungen werden in Mikro-Batches (max. 5ms Fenster) zusammengefasst, um IPC-Overhead zu minimieren.

### 2.5. LSP-Architektur

* **Modell:** LSP-Server werden als Kindprozesse des Extension Hosts gestartet und verwaltet (VS Code-kompatibel).
  * *Begründung:* Extensions wie `vscode-python` oder `vscode-eslint` starten und konfigurieren ihre eigenen Language Server. Dieses Modell beizubehalten maximiert die Extension-Kompatibilität.
* **Datenfluss:**
  ```
  Natives Frontend ←→ IPC-Brücke ←→ Extension Host ←→ LSP-Server
  ```
* **Optimierung:** Diagnostics (Fehlermeldungen) und Completion-Ergebnisse werden vom Extension Host gecacht und nur Deltas ans Frontend übertragen.

### 2.6. AI Context Engine + pi.dev (Der "Intuitionsteil") — NEU in v2.0

* **Technologie:** pi.dev als primäres Agenten-Framework, integriert als WASM-Modul oder via dediziertem Node.js-Host.
* **Zuständigkeiten:**
  * **Context Extraction:** Extraktion strukturierter Kontexte aus dem aktuellen Buffer (Rope-Snapshot), umgebenden Dateien, Tree-sitter AST, LSP-Symbolen und Workspace-Index.
  * **pi Integration:** pi als primärer Coding Agent für inline Completions, Chat, Natural-Language-Commands und agenten-basierte Workflows.
  * **Streaming & Debouncing:** Latenzoptimierte Streaming-Antworten (< 200ms für Completions).
  * **Multi-Agent Orchestrierung:** Fähigkeit, mehrere pi-Agents parallel zu koordinieren (Planer, Coder, Reviewer, Tester).
  * **On-Device vs. Cloud:** Unterstützung lokaler Modelle (z.B. via Ollama, llama.cpp) sowie Cloud-Provider (OpenAI, Anthropic, Groq) mit einheitlicher API.
* **Sicherheitsmodell:**
  * Explizite User-Bestätigung bei Datei-Änderungen durch Agents.
  * Capability-basiertes System: `ai_context_read`, `ai_generate`, `ai_agent_spawn`.
  * Context-Filtering (z.B. keine Geheimnisse aus `.env`).

**Begründung für pi.dev:**
- pi ist speziell für hybride Rust + Node.js + WASM-Projekte optimiert.
- Bietet bereits fertige Patterns für Agenten-Orchestrierung, Tool-Use und TUI-Integration.
- Ermöglicht es, CoreCode selbst mit pi zu entwickeln (Self-Hosting-Effekt).

---

## 3. Strategie für die API-Implementierung (Gestufte KI-Agenten-Pipeline)

Die größte technische Hürde ist das Mapping der gigantischen VS Code API (`vscode.d.ts`). Dies wird durch einen gestuften Ansatz gelöst:

### Tier 1 — Manuell (Kern-APIs)

Die ~20 kritischsten APIs werden handschriftlich implementiert und dienen als Referenz-Implementation:
* `vscode.workspace.textDocuments` / `onDidChangeTextDocument`
* `vscode.window.showInformationMessage` / `showWarningMessage` / `showErrorMessage`
* `vscode.languages.registerCompletionItemProvider`
* `vscode.languages.registerHoverProvider`
* `vscode.languages.createDiagnosticCollection`
* `vscode.commands.registerCommand` / `executeCommand`
* `vscode.window.createOutputChannel`
* `vscode.workspace.getConfiguration`
* `vscode.window.showQuickPick` / `showInputBox`

### Tier 2 — KI-assistiert (Erweiterte APIs)

* KI-Agenten generieren TypeScript-Boilerplate für RPC-Serialisierung und Rust-Code für Deserialisierung.
* **Jeder generierte Binding durchläuft manuelles Code-Review.**
* Conformance Tests gegen den echten VS Code Extension Host validieren Korrektheit.

### Tier 3 — KI-automatisiert (Triviale APIs)

* Reine Daten-Weiterleitungen ohne komplexe Logik.
* Automatisierte Generierung mit CI-basierter Validierung.
* Manuelles Review nur bei Test-Fehlschlägen.

### Conformance Test Suite

* Für jede implementierte API existiert ein Test, der das Verhalten gegen den originalen VS Code Extension Host vergleicht.
* CI-Pipeline: Generierter Code wird automatisch gegen die Test Suite validiert.
* Bei VS Code API-Updates wird die Pipeline neu ausgeführt und Abweichungen werden als Regressions-Tests sichtbar.

---

## 4. AI-Strategie (NEU in v2.0)

### 4.1 Kern-Use-Cases (priorisiert)

| Priorität | Use-Case                        | Beschreibung                                                                 | UX-Modell                  |
|-----------|---------------------------------|------------------------------------------------------------------------------|----------------------------|
| P0        | Inline Completions              | Ghost-Text Vorschläge während des Tippens                                    | Cursor-ähnlich             |
| P0        | Explain Code                    | Natürlichsprachige Erklärung markierten Codes                                | Sidebar + Inline Highlights |
| P0        | Generate Tests                  | Unit-/Integrationstests aus vorhandenem Code generieren                      | Diff-Preview + Accept      |
| P1        | Natural Language Commands       | "Refactor this to async", "Add error handling", "Extract to function"        | Command Palette            |
| P1        | Chat Sidebar                    | Konversation mit Projektkontext (ähnlich Copilot Chat)                       | Side Panel                 |
| P1        | Intelligent Diagnostics         | KI-gestützte Erklärungen von LSP-Diagnostics + Auto-Fixes                    | Gutter + Quick Fix         |
| P2        | Multi-File Refactoring          | Agent plant und führt projektweite Refactorings aus (mit Confirmation)       | Plan-Review UI             |
| P2        | Agent Workflows                 | "Implement Feature X" → Planer + Coder + Reviewer + Tester                   | TUI / Sidebar              |

### 4.2 Context-Engine Anforderungen

* **Rope Snapshot:** Snapshot des aktuellen Buffers bei AI-Aufruf (inkl. Cursor-Position, Selektion).
* **Tree-sitter AST:** Strukturierte Repräsentation der umgebenden Funktion/Klasse.
* **LSP Symbols:** Verfügbare Symbole im Scope (via Language Server).
* **Workspace Index:** Leichter Datei- und Symbol-Index (Dateiname, Exports, Imports).
* **File Context:** Relevante umgebende Dateien (max. 3–5 Dateien, configurable).
* **Privacy Filter:** Automatisches Entfernen von Geheimnissen (`.env`, Private Keys) aus dem Context.

### 4.3 pi.dev als primäres Agenten-Framework

* **Integration Point:** pi läuft als WASM-Modul (in-process) oder als dedizierter Node.js Prozess.
* **WIT API Erweiterung:** Neue Interfaces für AI-Context-Queries und Agent-Spawning.
* **Self-Hosting:** CoreCode-Entwicklung selbst nutzt pi (Dogfooding).
* **Extension Points:** pi-Agents können als WASM-Extensions von Drittanbietern installiert werden.

---

## 5. Nicht-funktionale Anforderungen

| Metrik | Ziel (MVP) | Messmethode |
|:---|:---|:---|
| **Startup-Zeit** | < 500ms bis erstes sichtbares Frame (Cold Start) | Benchmark-Suite, Zeitmessung ab Prozessstart |
| **Frame-Zeit** | < 16ms (60 FPS) während Eingabe | GPU-Profiling |
| **RAM (Baseline)** | < 150MB ohne Extensions | OS-Prozessmonitor |
| **RAM (mit 5 Extensions)** | < 400MB | OS-Prozessmonitor |
| **IPC-Latenz** | < 5ms für einzelne Nachrichten | Instrumentierte Benchmarks |
| **Extension-Kompatibilität** | Top 20 VS Code Extensions funktionsfähig | Kompatibilitätsmatrix (siehe Abschnitt 8) |
| **Plattformen (MVP)** | Linux, macOS | CI-Tests auf beiden Plattformen |
| **Plattformen (Post-MVP)** | + Windows | Windows-spezifische Anpassungen (Named Pipes, DirectWrite) |
| **AI Completion Latency** | < 200ms (P95) für Inline Completions | Instrumentierte Benchmarks |
| **AI Context Size** | ≤ 32k Tokens pro Request (configurable) | Token-Zählung |

### Accessibility (Post-MVP)

* Screen Reader-Unterstützung über plattform-native Accessibility-APIs (AT-SPI/Linux, NSAccessibility/macOS).
* Vollständige Keyboard-Navigation.
* High-Contrast-Themes.

---

## 6. Kernanforderungen für das MVP (Minimum Viable Product)

### 6.1. Lifecycle Management

* Das native Frontend startet den Node.js-Prozess beim Start.
* Überwachung des Node.js-Prozesses (Restart bei Crash, Graceful Shutdown beim Beenden des Editors).
* Startup-Sequenz: Frontend-Fenster sofort anzeigen, Extension Host im Hintergrund starten (Progressive Loading).

### 6.2. Extension Loading & Activation

* Parsen der `package.json` einer Standard-Extension.
* Unterstützung der grundlegenden VS Code *Activation Events* (z.B. `onLanguage:javascript`, `onCommand:extension.helloWorld`, `*`).
* Extension-Discovery: Lokales Verzeichnis scannen (kein Marketplace im MVP).

### 6.3. Text & Workspace Synchronisation (Der kritische Pfad)

* Implementierung von `vscode.workspace.textDocuments`.
* Verzögerungsfreie Übertragung von Textänderungen (Deltas) vom Frontend an den Extension Host via FlatBuffers.
* Konfliktfreie Synchronisation bei gleichzeitigen Änderungen von Extension und User (OT oder CRDT als Fallback).

### 6.4. Basis-UI-Mapping

* **Notifications:** Mapping von `vscode.window.showInformationMessage` auf native OS-Benachrichtigungen (Tauri Notification API).
* **Diagnostics:** Mapping der Fehlermarkierungen (rote Wellenlinien) vom Extension Host zurück in den Renderer des Frontends.
* **Quick Pick / Command Palette:** Nativ gerenderte Command Palette, die Befehle an den Host triggert.
* **Status Bar:** Basis-Statusleiste für Extension-Beiträge.

### 6.5. AI MVP Features (NEU in v2.0)

* **Explain Code:** Markierten Code per Hotkey oder Kontextmenü erklären (via pi).
* **Generate Tests:** Button "Generate Unit Tests" erzeugt Test-Datei mit Diff-Preview.
* **Inline Completions:** Erste Ghost-Text Vorschläge (deaktivierbar).
* **AI Chat Sidebar:** Minimales Chat-Panel mit aktuellem Buffer als Context.
* **Capability Guard:** Alle AI-Features erfordern explizite `ai_*` Capabilities in `corecode.toml`.

---

## 7. Out of Scope (Für das MVP)

* **WebViews:** Komplette HTML/CSS-Fenster innerhalb von Extensions (erfordert Browser-Engine).
* **Integrierter Terminal-Emulator** (Fokus liegt zunächst auf Code-Editing).
* **Integrierter Debugger-UI (DAP)** (Nur Basis-LSP-Support im ersten Schritt).
* **Settings Sync** (Cloud-Synchronisation).
* **Windows-Support** (Post-MVP, siehe Abschnitt 5).
* **Extension Marketplace** (Extensions werden lokal installiert).
* **Multi-File Agent Refactorings** (P2, nur in AI-Phase 3).

---

## 8. Extension-Kompatibilitätsmatrix (Top 20 Ziel-Extensions)

| # | Extension | Benötigte APIs (Kern) | Priorität |
|:--|:---|:---|:---|
| 1 | ESLint | Diagnostics, TextDocument, Configuration | P0 |
| 2 | Prettier | Formatting, TextEdit, Configuration | P0 |
| 3 | TypeScript Language Features | LSP (vollständig), Completions, Hover, Diagnostics | P0 |
| 4 | Python (Pylance) | LSP, Diagnostics, Configuration, Terminal* | P0 |
| 5 | GitLens | SCM API, Decorations, TreeView* | P1 |
| 6 | GitHub Copilot | InlineCompletions, Authentication*, Webview* | P1 |
| 7 | Rust Analyzer | LSP, Diagnostics, CodeActions | P0 |
| 8 | Go (gopls) | LSP, Diagnostics, Formatting | P1 |
| 9 | Docker | TreeView*, Terminal* | P2 |
| 10 | Remote - SSH | Vollständig eigene Architektur* | P2 |
| 11 | Tailwind CSS IntelliSense | LSP, Completions, Hover | P1 |
| 12 | Auto Rename Tag | TextDocument, TextEdit | P1 |
| 13 | Bracket Pair Colorizer | Decorations, TextDocument | P1 |
| 14 | Path Intellisense | Completions, Workspace | P1 |
| 15 | Material Icon Theme | IconTheme API | P2 |
| 16 | Error Lens | Diagnostics, Decorations | P1 |
| 17 | Code Spell Checker | Diagnostics, Configuration, CodeActions | P1 |
| 18 | indent-rainbow | Decorations | P2 |
| 19 | TODO Highlight | Decorations, Configuration | P2 |
| 20 | YAML | LSP, Diagnostics | P1 |

*\* = benötigt APIs die im MVP Out-of-Scope sind; Extension wird nur teilweise funktionieren.*

---

## 9. Lizenzierung & Distribution

### Extension-Quellen

* **MVP:** Extensions werden manuell als `.vsix`-Dateien installiert.
* **Post-MVP:** Integration mit **Open VSX Registry** (Eclipse Foundation, open-source).
* **Nicht nutzen:** VS Code Marketplace (Microsoft ToS verbieten Nutzung durch Nicht-VS-Code-Produkte).

### Projekt-Lizenz

* Der Extension Host Fork basiert auf VS Code OSS (MIT-Lizenz) — Kompatibel.
* Eigener Code: Lizenz TBD (Empfehlung: MIT oder Apache 2.0 für maximale Community-Adoption).

---

## 10. Technische Risiken & Mitigierung

| Risiko | Beschreibung | Wahrscheinlichkeit | Impact | Mitigierung |
|:---|:---|:---|:---|:---|
| **Performance-Bottleneck IPC** | Zu viele RPC-Aufrufe zwischen Rust und Node.js. | Mittel | Hoch | FlatBuffers, Batching, Shared Memory für große Payloads. |
| **API Drift** | Microsoft ändert Kernkomponenten der VS Code API. | Hoch | Mittel | Gestufte KI-Pipeline + Conformance Tests; Fokus auf stabile Kern-APIs. |
| **Speicherlecks im Host** | Fehlerhaft gemappte Garbage Collection über Prozessgrenzen. | Mittel | Mittel | Strikte Ressourcen-Verwaltung, Timeout-Regeln, Memory-Monitoring. |
| **VS Code Marketplace ToS** | Extensions dürfen nicht von Nicht-VS-Code genutzt werden. | Sicher | Hoch | Open VSX Registry; kein Marketplace im MVP. |
| **Text-Rendering-Qualität** | Eigenes Rendering unter Chromium/CoreText-Niveau. | Mittel | Hoch | Plattform-native Schrift-APIs (DirectWrite, CoreText, FreeType). |
| **Extension-Kompatibilität** | Extensions nutzen undokumentierte VS Code-Interna. | Hoch | Mittel | Kompatibilitätsmatrix; Tier-basiertes API-Mapping; Community-Feedback. |
| **KI-generierter Code** | Halluzinationen in generierten API-Bindings. | Hoch | Hoch | Conformance Tests, manuelles Review für Tier 1+2, CI-Validierung. |
| **AI Context Leakage** | Geheimnisse oder sensible Daten gelangen in KI-Requests. | Mittel | Hoch | Privacy Filter, Capability-Modell, explizite User-Bestätigung. |
| **AI Latency** | Zu hohe Latenz bei Inline Completions führt zu schlechter UX. | Mittel | Hoch | Debouncing, kleine Context-Window, lokale Modelle (Ollama). |
| **pi Abhängigkeit** | pi.dev ist ein externes Projekt mit eigenem Release-Zyklus. | Niedrig | Mittel | Fallback auf direkte OpenAI/Anthropic Calls; pi als optionales Modul. |

---

## 11. Meilensteine

| Meilenstein | Beschreibung | Ziel-Zeitraum |
|:---|:---|:---|
| **M0: Technologie-Spike** | Frontend-Framework-Evaluation (Tauri+wgpu PoC) | 2 Wochen |
| **M1: Hello World** | Rust-Editor rendert Text, Node.js Extension Host startet, IPC funktioniert | 6 Wochen |
| **M2: Erste Extension** | ESLint Extension lädt, zeigt Diagnostics im Editor | 4 Wochen |
| **M3: MVP Alpha** | Top 5 Extensions funktionsfähig, Tree-sitter Highlighting, Command Palette | 8 Wochen |
| **M4: MVP Beta** | Top 20 Extensions, Performance-Optimierung, macOS+Linux | 8 Wochen |
| **M5: AI Strategy** | AI-Strategie-Dokument, pi.dev Setup, erste Context-Engine | 3 Wochen |
| **M6: AI Context + Explain** | pi Integration, Context-Engine, "Explain Code" Feature | 4 Wochen |
| **M7: Inline Completions** | Ghost-Text Completions (< 200ms P95), Test-Generation | 6 Wochen |
| **M8: AI Chat + Multi-Agent** | Chat Sidebar, Natural Language Commands, erste Agent-Workflows | 8 Wochen |

---

## 12. Fazit

CoreCode v2.0 erweitert die bewährte "Frankenstein"-Architektur um eine erste Bürger-KI-Schicht. Durch die Integration von **pi.dev** als primäres Agenten-Framework wird CoreCode zu einer echten **AI-native Plattform**, die gleichzeitig die Stärken nativer Performance, VS Code Extension-Kompatibilität und moderne Agenten-basierten Workflows vereint.

Die gestufte KI-Agenten-Pipeline für die API-Implementierung bleibt bestehen und wird nun zusätzlich für die AI-Context-Engine und Agent-Orchestrierung genutzt.

---

**Ende des Dokuments (Version 2.0)**